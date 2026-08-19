/**
 * In-memory registry of connected media nodes (Go backends). Keyed by nodeId
 * (derived from NODE_IDENTIFIER). Tracks socket connections, origins, and active
 * stream counts for load-balanced ingest routing. All state is volatile —
 * nodes re-register on reconnect, and session rows in the DB are the durable
 * record of which node handled which stream.
 */
import type { Server as SocketIOServer, Socket } from 'socket.io'
import { env } from '../utils/env'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'

export interface MediaNodeInfo {
  nodeId: string
  socketId: string
  origin: string
  /** browser-reachable base ("" = via the app's host, single-server default) */
  publicOrigin: string
  /** PUBLIC RTMP port for OBS URLs on this node (1935 unless tunnelled otherwise) */
  publicRtmpPort: number
  rtmpPort: number
  srtPort: number
  hostname: string
  version: string
  connectedAt: number
  activeStreams: number
  /**
   * This node's SRS HTTP-FLV base AS REACHABLE FROM THIS BACKEND — the address
   * the playback proxy pulls from. Reported by the node at registration
   * (SRS_FLV_BASE), so a shared Docker network advertises its service name
   * (http://srs:38081 — the SRS SIDECAR, not the node itself; 38080 is the node's play entry) while a remote node advertises its public origin.
   */
  srsFlvBase: string
}

/** nodeId → info */
const nodes = new Map<string, MediaNodeInfo>()
/** socketId → nodeId (reverse lookup for disconnect cleanup) */
const socketToNode = new Map<string, string>()

/** Derive a stable nodeId from the node's NODE_IDENTIFIER. */
export function deriveNodeId(origin: string): string {
  return origin
    .replace(/^https?:\/\//, '')
    .replace(/[:\/].*$/, '')
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
}

/** Register (or re-register) a node connection. Returns the nodeId. */
export function register(
  socket: Socket,
  info: Omit<
    MediaNodeInfo,
    'nodeId' | 'socketId' | 'connectedAt' | 'activeStreams' | 'srsFlvBase' | 'publicOrigin'
  > & { srsFlvBase?: string; publicOrigin?: string; publicRtmpPort?: number },
): string {
  const nodeId = deriveNodeId(info.origin)
  const existing = nodes.get(nodeId)
  const entry: MediaNodeInfo = {
    ...info,
    nodeId,
    socketId: socket.id,
    connectedAt: Date.now(),
    activeStreams: existing?.activeStreams ?? 0,
    // fall back to the origin host for nodes that don't advertise an FLV base
    srsFlvBase: info.srsFlvBase || `http://${info.origin.replace(/^https?:\/\//, '').split(':')[0]}:38081`,
    publicOrigin: info.publicOrigin || '',
    publicRtmpPort: info.publicRtmpPort ?? 1935,
  }
  nodes.set(nodeId, entry)
  socketToNode.set(socket.id, nodeId)
  console.log(
    `[media-nodes] registered: ${nodeId} (${info.hostname}) origin=${info.origin} flv=${entry.srsFlvBase}`,
  )
  return nodeId
}

/** Remove a node on socket disconnect. Sessions stay (reconnect re-syncs). */
export function disconnect(socketId: string): string | null {
  const nodeId = socketToNode.get(socketId)
  if (!nodeId) return null
  socketToNode.delete(socketId)
  const node = nodes.get(nodeId)
  if (node && node.socketId === socketId) {
    nodes.delete(nodeId)
    console.log(`[media-nodes] disconnected: ${nodeId} (${node.hostname})`)
  }
  return nodeId
}

/** Get a node's info by nodeId. */
export function getNode(nodeId: string): MediaNodeInfo | undefined {
  return nodes.get(nodeId)
}

/** List all connected nodes. */
export function listNodes(): MediaNodeInfo[] {
  return [...nodes.values()].sort((a, b) => a.connectedAt - b.connectedAt)
}

/** Pick the least-loaded node for new ingest (null if none registered). */
export function pickIngestNode(): MediaNodeInfo | null {
  const all = listNodes()
  if (all.length === 0) return null
  return all.reduce((min, n) => (n.activeStreams < min.activeStreams ? n : min))
}

/** Increment/decrement a node's active stream count. */
export function adjustStreamCount(nodeId: string, delta: number): void {
  const node = nodes.get(nodeId)
  if (node) {
    node.activeStreams = Math.max(0, node.activeStreams + delta)
  }
}

/** Get the Socket.IO socket for a node (for emitting commands). */
export function getSocket(io: SocketIOServer, nodeId: string): Socket | null {
  const node = nodes.get(nodeId)
  if (!node) return null
  const ns = io.of('/media-node')
  const socket = ns.sockets.get(node.socketId)
  return socket ?? null
}

/**
 * Resolve which HTTP-FLV base THIS BACKEND should pull a live stream from:
 * the hosting media node's advertised address when the session is remote,
 * else the local SRS fallback (dev / app-managed SRS).
 */
export function resolveFlvBase(streamName: string): string {
  const node = getHostingNode(streamName)
  return node ? node.srsFlvBase : env.srsFlvBase
}

/** The media node currently hosting an active stream (undefined = local). */
export function getHostingNode(streamName: string): MediaNodeInfo | undefined {
  const session = PublishSessionsRepository.findActiveByStream(streamName)
  if (!session?.nodeId) return undefined
  return nodes.get(session.nodeId)
}

/** Emit an event to a specific node. Returns false if node not connected. */
export function emitToNode(io: SocketIOServer, nodeId: string, event: string, payload: unknown): boolean {
  const socket = getSocket(io, nodeId)
  if (!socket) return false
  socket.emit(event, payload)
  return true
}

/** Emit an event to all connected nodes. */
export function broadcastToNodes(io: SocketIOServer, event: string, payload: unknown): void {
  io.of('/media-nodes').emit(event, payload)
}
