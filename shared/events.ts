/**
 * Realtime event payloads — emitted on the server bus and forwarded to clients
 * over Socket.IO (Phase 5). Kept in shared/ so the Vue client uses the same types.
 */

export type SessionStatus =
  | 'pending'
  | 'allowed'
  | 'rejected'
  | 'compliant'
  | 'violating'
  | 'killed'
  | 'ended'

export interface SessionSnapshot {
  sessionId: number
  eventId: number | null
  streamName: string
  status: SessionStatus
  /** null for media-node sessions (kick routes by nodeId instead) */
  srsClientId: string | null
  /** hosting media node (null = local session on this backend) */
  nodeId: string | null
  width: number | null
  height: number | null
  fps: number | null
  /** video-only estimate (total minus declared audio) */
  videoBitrateKbps: number | null
  /** declared AUDIO rate (OBS Audio Bitrate) */
  audioBitrateKbps: number | null
  compliant: boolean
  rejectReason: string | null
  /** epoch ms */
  startedAt: number
  /** epoch ms */
  endedAt: number | null
}

export interface ViolationSnapshot extends SessionSnapshot {
  reasons: string[]
}

export interface RecordingSnapshot {
  id: number
  eventId: number | null
  sessionId: number | null
  streamName: string
  studentLabel: string | null
  filePath: string
  sizeBytes: number
  durationSec: number | null
  /** epoch ms */
  startedAt: number
}

export type AuditLevel = 'info' | 'warn' | 'error'
export type AuditCategory =
  | 'auth'
  | 'publish'
  | 'access'
  | 'config'
  | 'recording'
  | 'system'
  | 'admin'

export interface AuditSnapshot {
  id?: number
  ts: number
  level: AuditLevel
  category: AuditCategory
  /** who performed the action (account email); null = system/background */
  actor?: string | null
  eventId: number | null
  streamName: string | null
  message: string
  detail?: unknown
}

/** Server bus event map. */
/** One media node row for the admin nodes page (GET /api/media-nodes shape). */
export interface MediaNodeSnapshot {
  nodeId: string
  /** OBS ingest URL (null = single-server: users push via the app's host) */
  rtmpUrl: string | null
  /** public reachability reported by the node, handed through to browsers */
  publicOrigin: string
  publicRtmpPort: number
  /** STUN latency-probe responder port (0 = old firmware, no probe) */
  publicProbeUdpPort: number
  /** SRS WebRTC media UDP port (0 = unreported) */
  publicSrsUdpPort: number
  version: string
  activeStreams: number
  connectedAt: number
  maxUsers: number
  assignedUsers: number
  users: { id: number; email: string }[]
}

export interface BusEventMap {
  'session:start': SessionSnapshot
  'session:metric': SessionSnapshot
  'session:violation': ViolationSnapshot
  'session:stop': SessionSnapshot
  'recording:ready': RecordingSnapshot
  'audit:created': AuditSnapshot
  'config:changed': unknown
  /** full node list — sent on every registry/quota/assignment change */
  'nodes:changed': MediaNodeSnapshot[]
}

export type BusEventName = keyof BusEventMap
