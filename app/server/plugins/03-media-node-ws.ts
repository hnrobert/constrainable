/**
 * Media-node control WebSocket — Bun-native transport.
 *
 * WHY a separate listener: the Nitro/crossws route (server/routes/ws/media-node.ts,
 * same port as the app) rides on node:http 'upgrade' — and under the BUN
 * runtime that path is fundamentally broken: bytes written to the upgrade
 * socket never reach the peer (verified with both the ws library and a
 * hand-rolled 101). Bun.serve({ websocket }) is the working native path, so
 * under Bun we start it here on its own port (MEDIA_NODE_WS_PORT, default
 * 31955 — backend-internal: nodes reach it over the docker network, it does
 * NOT need to be published through the reverse proxy).
 *
 * Under a real Node runtime this plugin is a no-op and the crossws route on
 * the main port serves the same protocol instead. Both funnel into
 * services/media-node-ws.ts (transport-agnostic handlers).
 */
import { randomUUID } from 'node:crypto'
import { onWsOpen, onWsMessage, onWsClose, type WsPeer } from '../services/media-node-ws'

/** minimal structural types — keeps this independent of @types/bun resolution */
interface BunServerWebSocket {
  data: { peerId: string }
  send: (data: string | Uint8Array) => number
  close: (code?: number, reason?: string) => void
}
interface BunServeOptions {
  port: number
  hostname?: string
  fetch: (req: Request, server: { upgrade: (req: Request, opts?: { data?: unknown }) => boolean }) => Response | undefined
  websocket: {
    open: (ws: BunServerWebSocket) => void
    message: (ws: BunServerWebSocket, message: string | Buffer) => void
    close: (ws: BunServerWebSocket) => void
  }
}
type BunGlobal = { serve: (opts: BunServeOptions) => unknown }

export default defineNitroPlugin(() => {
  const B = (globalThis as { Bun?: BunGlobal }).Bun
  if (!B?.serve) {
    console.log('[media-ws] non-Bun runtime — serving on the main port via crossws (/ws/media-node)')
    return
  }

  const port = Number(process.env.MEDIA_NODE_WS_PORT || '31955')
  const peerOf = (ws: BunServerWebSocket): WsPeer => ({
    id: ws.data.peerId,
    send: (d) => {
      ws.send(d)
    },
    close: (c, r) => {
      ws.close(c, r)
    },
  })

  B.serve({
    port,
    hostname: process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : undefined,
    fetch(req, server) {
      if (new URL(req.url).pathname === '/ws/media-node' && server.upgrade(req, { data: { peerId: randomUUID() } })) {
        return undefined // upgraded — connection continues in the websocket hooks
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open: (ws) => onWsOpen(peerOf(ws)),
      message: (ws, message) => {
        const data = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)
        void onWsMessage(peerOf(ws), data).catch((err) => {
          console.error('[media-ws] message handling failed:', err)
          try {
            ws.close(1011)
          } catch {
            /* already closed */
          }
        })
      },
      close: (ws) => onWsClose(peerOf(ws)),
    },
  })
  console.log(`[media-ws] Bun-native control WebSocket listening on :${port}/ws/media-node`)
})
