/**
 * Admin browser realtime — native WebSocket on the Bun gateway (/ws/admin),
 * successor of the retired socket.io /socket namespace. Session-cookie
 * authenticated at the handshake (admins only) and topic-scoped, so a future
 * /ws/user audience is just another topic set (user connections subscribe to
 * user:{id} / event:{id} instead of 'admin').
 *
 * Frames are JSON [eventName, payload] — the same event names and payload
 * shapes the socket.io bridge forwarded, so the useSocket composable kept its
 * consumer API. Clients send an app-level "ping" every 25s; the server
 * replies "pong" and drops silent connections after 90s (mirrors the node
 * control channel's liveness contract).
 */
import { onBus } from '../utils/bus'
import type { BusEventMap, BusEventName } from '#shared/events'
import { readSessionCookie } from '../utils/session'
import { UsersRepository } from '../repositories/users.repository'
import type { WsPeer } from './media-node-ws'

export interface AdminAuth {
  userId: number
  role: 'admin' | 'user'
}

const IDLE_TIMEOUT_MS = 90_000

interface AdminConn {
  peer: WsPeer
  auth: AdminAuth
  topics: Set<string>
  idleTimer: ReturnType<typeof setTimeout>
}

/** peerId → conn (dispatch); adminId → peerId (one live conn per admin) */
const conns = new Map<string, AdminConn>()
const byAdmin = new Map<number, string>()

/**
 * Handshake auth: the sid cookie → session payload → the CURRENT role from
 * the DB (same semantics as the 01-auth middleware — the cookie only proves
 * identity, the role is always re-resolved).
 */
export async function authenticateAdmin(cookieHeader: string | null): Promise<AdminAuth | null> {
  const raw = cookieHeader?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1]
  if (!raw) return null
  const payload = await readSessionCookie(decodeURIComponent(raw))
  if (!payload) return null
  const user = UsersRepository.findById(payload.uid)
  if (!user) return null
  return { userId: user.id, role: user.role }
}

/** Fan an event out to every connection subscribed to a topic. */
export function publish(topic: string, event: string, payload: unknown): void {
  for (const conn of conns.values()) {
    if (conn.topics.has(topic)) {
      conn.peer.send(JSON.stringify([event, payload]))
    }
  }
}

function touchIdle(conn: AdminConn): void {
  clearTimeout(conn.idleTimer)
  conn.idleTimer = setTimeout(() => conn.peer.close(4004, 'idle timeout'), IDLE_TIMEOUT_MS)
}

export function onAdminWsOpen(peer: WsPeer, auth: AdminAuth): void {
  // one live connection per admin — a second tab replaces the first
  const prevPeerId = byAdmin.get(auth.userId)
  if (prevPeerId) {
    const prev = conns.get(prevPeerId)
    if (prev) {
      clearTimeout(prev.idleTimer)
      conns.delete(prevPeerId)
      prev.peer.close(4000, 'superseded by a newer connection')
    }
  }
  const conn: AdminConn = {
    peer,
    auth,
    // admins receive the full dashboard stream; future user connections
    // subscribe to user:{id} / event:{id} instead
    topics: new Set(['admin']),
    idleTimer: setTimeout(() => peer.close(4004, 'idle timeout'), IDLE_TIMEOUT_MS),
  }
  conns.set(peer.id, conn)
  byAdmin.set(auth.userId, peer.id)
  console.log(`[admin-ws] admin ${auth.userId} connected (${conns.size} live)`)
}

export function onAdminWsMessage(peer: WsPeer, text: string): void {
  const conn = conns.get(peer.id)
  if (!conn) return
  touchIdle(conn)
  if (text === 'ping') {
    conn.peer.send('pong')
  }
}

export function onAdminWsClose(peer: WsPeer): void {
  const conn = conns.get(peer.id)
  if (!conn) return
  conns.delete(peer.id)
  if (byAdmin.get(conn.auth.userId) === peer.id) {
    byAdmin.delete(conn.auth.userId)
  }
  clearTimeout(conn.idleTimer)
  console.log(`[admin-ws] admin ${conn.auth.userId} disconnected (${conns.size} live)`)
}

/** bus → admin bridge (the events 00-socket.ts used to forward verbatim). */
export function initAdminWs(): void {
  const FORWARD: BusEventName[] = [
    'session:start',
    'session:metric',
    'session:violation',
    'session:stop',
    'recording:ready',
    'audit:created',
    'config:changed',
    'nodes:changed',
  ]
  for (const name of FORWARD) {
    onBus(name, (payload: BusEventMap[typeof name]) => publish('admin', name, payload))
  }
}
