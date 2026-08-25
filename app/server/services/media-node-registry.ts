/**
 * In-memory registry of connected media nodes (Go backends). Keyed by nodeId
 * (derived from the node-reported identifier). Tracks connections and active
 * stream counts. All state is volatile — nodes re-register on reconnect, and
 * session rows in the DB are the durable record of which node handled which
 * stream.
 */
import { env } from '../utils/env'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'

export interface MediaNodeInfo {
  nodeId: string
  socketId: string
  identifier: string
  /**
   * Public reachability reported at registration (PUBLIC_MEDIA_NODE_ORIGIN /
   * PUBLIC_MEDIA_NODE_RTMP_PORT / PUBLIC_MEDIA_NODE_PROBE_UDP_PORT / PUBLIC_MEDIA_NODE_SRS_UDP_PORT on the
   * node). publicOrigin "" = users push via the app's host. All four are
   * handed through to the frontend (OBS URL, ICE latency probe, WebRTC).
   */
  publicOrigin: string
  publicRtmpPort: number
  publicProbeUdpPort: number
  publicSrsUdpPort: number
  hostname: string
  version: string
  connectedAt: number
  activeStreams: number
  /**
   * This node's SRS HTTP-FLV base AS REACHABLE FROM THIS BACKEND — the address
   * the playback proxy pulls from. Reported by the node at registration
   * (SRS_FLV_BASE), so a shared Docker network advertises its service name
   * (http://srs:38081 — the SRS SIDECAR, not the node itself).
   */
  srsFlvBase: string
}

/** nodeId → info */
const nodes = new Map<string, MediaNodeInfo>()
/** connection id → nodeId (reverse lookup for disconnect cleanup) */
const socketToNode = new Map<string, string>()

/**
 * OBS ingest authority for a node — "host[:port]", the redundant :1935
 * omitted (shared/rtmp.ts normalizes it again downstream). '' = via app host.
 */
export function rtmpAuthority(n: { publicOrigin: string; publicRtmpPort?: number }): string {
  if (!n.publicOrigin) return ''
  const port = n.publicRtmpPort ?? 1935
  return port === 1935 ? n.publicOrigin : `${n.publicOrigin}:${port}`
}

/** Derive a stable nodeId from the node's NODE_IDENTIFIER. */
function deriveNodeId(origin: string): string {
  return origin
    .replace(/^https?:\/\//, '')
    .replace(/[:/].*$/, '')
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
}

/** Register (or re-register) a node connection. Returns the nodeId.
 *  `peer` is anything with a stable connection id (the WS gateway peer). */
export function register(
  peer: { id: string },
  // the public fields are optional at the call site (defaults applied below)
  info: Omit<
    MediaNodeInfo,
    | 'nodeId'
    | 'socketId'
    | 'connectedAt'
    | 'activeStreams'
    | 'srsFlvBase'
    | 'publicOrigin'
    | 'publicRtmpPort'
    | 'publicProbeUdpPort'
    | 'publicSrsUdpPort'
  > & {
    srsFlvBase?: string
    publicOrigin?: string
    publicRtmpPort?: number
    publicProbeUdpPort?: number
    publicSrsUdpPort?: number
  },
): string {
  const nodeId = deriveNodeId(info.identifier || info.hostname)
  const existing = nodes.get(nodeId)
  const entry: MediaNodeInfo = {
    ...info,
    nodeId,
    socketId: peer.id,
    connectedAt: Date.now(),
    activeStreams: existing?.activeStreams ?? 0,
    srsFlvBase: info.srsFlvBase || `http://${info.identifier}:38081`,
    publicOrigin: info.publicOrigin || '',
    publicRtmpPort: info.publicRtmpPort || 1935,
    publicProbeUdpPort: info.publicProbeUdpPort ?? 0,
    publicSrsUdpPort: info.publicSrsUdpPort ?? 0,
  }
  nodes.set(nodeId, entry)
  socketToNode.set(peer.id, nodeId)
  console.log(`[media-nodes] registered: ${nodeId} (${info.hostname}) flv=${entry.srsFlvBase}`)
  return nodeId
}

/** Remove a node on disconnect. Sessions stay (reconnect re-syncs). */
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

/** Increment/decrement a node's active stream count. */
export function adjustStreamCount(nodeId: string, delta: number): void {
  const node = nodes.get(nodeId)
  if (node) {
    node.activeStreams = Math.max(0, node.activeStreams + delta)
  }
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
