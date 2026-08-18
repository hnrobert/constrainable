/**
 * Socket.IO event handlers for the /media-nodes namespace — the control-plane
 * side of the Go media-node connection. Handles node registration, publish
 * authorization (ack-based), session metrics, stream end, recording reports,
 * and violation alerts. All dashboard events go through the existing bus so
 * the frontend needs zero changes to see remote sessions.
 */
import type { Server as SocketIOServer, Socket } from 'socket.io'
import { env } from '../utils/env'
import { register, disconnect, adjustStreamCount, getNode } from './media-node-registry'
import { authorizePublish } from './access-control'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import { RecordingsRepository } from '../repositories/recordings.repository'
import { getConfig, getLimitsFor } from '../utils/config-store'
import { EventsRepository } from '../repositories/events.repository'
import { audit } from './audit'
import { emit } from '../utils/bus'
import type { SessionSnapshot, SessionStatus, RecordingSnapshot } from '#shared/events'

interface RegisterPayload {
  origin: string
  rtmpPort: number
  srtPort: number
  hostname: string
  version: string
}

interface PublishStartPayload {
  nodeId: string
  streamName: string
  token: string
  authedUser: string
  srsClientId: string
}

interface PublishAuthorizedAck {
  allow: boolean
  reason?: string
  sessionId?: number
  eventId?: number | null
  limits?: { maxWidth: number; maxHeight: number; maxFps: number; maxBitrateKbps: number }
  record?: boolean
}

interface MetricsPayload {
  sessionId: number
  width?: number
  height?: number
  fps?: number
  bitrateKbps?: number
}

interface EndPayload {
  sessionId: number
  endedAt: number
  durationSec: number
}

interface RecordingReadyPayload {
  nodeId: string
  streamName: string
  eventId: number | null
  sessionId?: number
  segments: { relPath: string; sizeBytes: number; durationSec: number }[]
  sizeBytes: number
  durationSec: number
  avgFps?: number
  width?: number
  height?: number
}

interface ViolationPayload {
  sessionId: number
  reasons: string[]
  metrics?: MetricsPayload
}

export function wireMediaNodeNamespace(io: SocketIOServer): void {
  const ns = io.of('/media-node')

  // Connection auth: verify the shared token (skip if empty = no auth)
  ns.use((socket, next) => {
    if (env.mediaNodeAuthToken === '') {
      return next() // no token configured → open access for media nodes
    }
    const token = socket.handshake.auth?.token
    if (token !== env.mediaNodeAuthToken) {
      return next(new Error('unauthorized'))
    }
    next()
  })

  ns.on('connection', (socket) => {
    console.log(`[media-nodes] socket connected: ${socket.id}`)

    socket.on('node:register', (payload: RegisterPayload, ack?: (r: { nodeId: string }) => void) => {
      const nodeId = register(socket, {
        origin: payload.origin,
        rtmpPort: payload.rtmpPort,
        srtPort: payload.srtPort,
        hostname: payload.hostname,
        version: payload.version,
      })
      // Push current limits config to the node
      const cfg = getConfig()
      socket.emit('config:limits', {
        global: cfg.limits,
        events: [],
      })
      ack?.({ nodeId })
    })

    socket.on('publish:start', async (payload: PublishStartPayload, ack?: (r: PublishAuthorizedAck) => void) => {
      const result = await handlePublishStart(socket, payload)
      ack?.(result)
    })

    socket.on('publish:metrics', (payload: MetricsPayload) => {
      handleMetrics(payload)
    })

    socket.on('publish:end', (payload: EndPayload) => {
      handleEnd(payload)
    })

    socket.on('recording:ready', (payload: RecordingReadyPayload) => {
      handleRecordingReady(payload)
    })

    socket.on('violation', (payload: ViolationPayload) => {
      handleViolation(payload)
    })

    socket.on('disconnect', () => {
      disconnect(socket.id)
    })
  })
}

// --- handlers ---

async function handlePublishStart(
  socket: Socket,
  payload: PublishStartPayload,
): Promise<PublishAuthorizedAck> {
  try {
    // Run the same authorization as SRS on_publish (token validation, bans, window)
    const auth = await authorizePublish({
      stream: payload.streamName,
      param: `?token=${payload.token}`,
    })

    if (!auth.allow) {
      audit('warn', 'access', `media-node publish rejected: ${payload.streamName} (${auth.reason})`, {
        streamName: payload.streamName,
        detail: { reason: auth.reason, nodeId: payload.nodeId },
      })
      return { allow: false, reason: auth.reason }
    }

    // Determine event limits + recording flag
    const event = auth.eventId ? EventsRepository.findById(auth.eventId) : null
    const limits = getLimitsFor(event)
    const cfg = getConfig()
    const record = cfg.record.enabled && (event?.recordEnabled ?? true)

    // Insert the session row (nodeId marks it as a remote media-node session)
    const row = PublishSessionsRepository.insert({
      eventId: auth.eventId ?? null,
      streamKeyId: auth.streamKeyId > 0 ? auth.streamKeyId : null,
      streamName: payload.streamName,
      srsClientId: payload.srsClientId || null,
      status: 'allowed',
      startedAt: new Date(),
    })

    // Update the session row's nodeId (via a direct update since the repo
    // insert doesn't have a nodeId param yet — Phase 2 schema migration)
    // TODO: add nodeId to the insert when the schema column lands

    adjustStreamCount(payload.nodeId, 1)

    // Emit session:start to the dashboard via the bus
    emit('session:start', buildSnapshot(row.id, auth.eventId ?? null, payload.streamName, 'allowed', false, row.startedAt.getTime()))

    audit('info', 'publish', `media-node publish started: ${payload.streamName}`, {
      eventId: auth.eventId ?? null,
      streamName: payload.streamName,
      detail: { nodeId: payload.nodeId, sessionId: row.id },
    })

    return {
      allow: true,
      sessionId: row.id,
      eventId: auth.eventId ?? null,
      limits: {
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxFps: limits.maxFps,
        maxBitrateKbps: limits.maxBitrateKbps,
      },
      record,
    }
  } catch (err) {
    console.error('[media-nodes] publish:start error:', err)
    return { allow: false, reason: 'internal error' }
  }
}

function handleMetrics(payload: MetricsPayload): void {
  const row = PublishSessionsRepository.findById(payload.sessionId)
  if (!row) return
  PublishSessionsRepository.updateMetrics(payload.sessionId, {
    width: payload.width ?? row.width,
    height: payload.height ?? row.height,
    fps: payload.fps ?? row.fps,
    bitrateKbps: payload.bitrateKbps ?? row.bitrateKbps,
  })
  emit('session:metric', buildSnapshot(
    payload.sessionId, row.eventId ?? null, row.streamName,
    row.status as SessionStatus, row.compliant, row.startedAt.getTime(),
    payload.width ?? row.width, payload.height ?? row.height,
    payload.fps ?? row.fps, payload.bitrateKbps ?? row.bitrateKbps,
  ))
}

function handleEnd(payload: EndPayload): void {
  const row = PublishSessionsRepository.findById(payload.sessionId)
  if (!row) return
  const finalStatus: SessionStatus = row.compliant ? 'compliant' : 'ended'
  PublishSessionsRepository.markEnded(payload.sessionId, finalStatus, new Date(payload.endedAt))
  emit('session:stop', buildSnapshot(
    payload.sessionId, row.eventId ?? null, row.streamName,
    finalStatus, row.compliant, row.startedAt.getTime(),
    row.width, row.height, row.fps, row.bitrateKbps, payload.endedAt,
  ))
  audit('info', 'publish', `media-node publish ended: ${row.streamName}`, {
    streamName: row.streamName,
    detail: { sessionId: payload.sessionId, durationSec: payload.durationSec },
  })
}

function handleRecordingReady(payload: RecordingReadyPayload): void {
  const existing = payload.eventId != null
    ? RecordingsRepository.findMergeTarget(payload.eventId, payload.streamName)
    : undefined

  if (existing) {
    // Append segments to the existing recording
    const segs: string[] = existing.segments ? JSON.parse(existing.segments) : [existing.filePath]
    segs.push(...payload.segments.map((s) => s.relPath))
    const prevDur = existing.durationSec ?? 0
    RecordingsRepository.update(existing.id, {
      segments: JSON.stringify(segs),
      sizeBytes: existing.sizeBytes + payload.sizeBytes,
      durationSec: prevDur + payload.durationSec,
      avgFps:
        existing.avgFps && payload.avgFps
          ? (existing.avgFps * prevDur + payload.avgFps * payload.durationSec) / Math.max(1, prevDur + payload.durationSec)
          : (payload.avgFps ?? existing.avgFps),
      width: payload.width ?? existing.width,
      height: payload.height ?? existing.height,
      endedAt: new Date(),
    })
    emit('recording:ready', buildRecordingSnapshot(existing.id, payload))
  } else {
    const rel = payload.segments[0]?.relPath ?? ''
    const row = RecordingsRepository.insert({
      eventId: payload.eventId ?? null,
      sessionId: payload.sessionId ?? null,
      streamName: payload.streamName,
      studentLabel: null,
      filePath: rel,
      segments: JSON.stringify(payload.segments.map((s) => s.relPath)),
      sizeBytes: payload.sizeBytes,
      durationSec: payload.durationSec,
      avgFps: payload.avgFps ?? null,
      width: payload.width ?? null,
      height: payload.height ?? null,
      startedAt: new Date(Date.now() - payload.durationSec * 1000),
      endedAt: new Date(),
    })
    emit('recording:ready', buildRecordingSnapshot(row.id, payload))
  }
}

function handleViolation(payload: ViolationPayload): void {
  const row = PublishSessionsRepository.findById(payload.sessionId)
  if (!row) return
  PublishSessionsRepository.updateStatus(payload.sessionId, 'violating')
  audit('warn', 'publish', `media-node violation: ${row.streamName} (${payload.reasons.join('; ')})`, {
    streamName: row.streamName,
    detail: { reasons: payload.reasons, nodeId: 'remote' },
  })
  emit('session:violation', {
    ...buildSnapshot(
      payload.sessionId, row.eventId ?? null, row.streamName,
      'violating', row.compliant, row.startedAt.getTime(),
      payload.metrics?.width, payload.metrics?.height,
      payload.metrics?.fps, payload.metrics?.bitrateKbps,
    ),
    reasons: payload.reasons,
  })
}

// --- snapshot helpers ---

function buildSnapshot(
  sessionId: number,
  eventId: number | null,
  streamName: string,
  status: SessionStatus,
  compliant: boolean,
  startedAt: number,
  width?: number | null,
  height?: number | null,
  fps?: number | null,
  bitrateKbps?: number | null,
  endedAt?: number | null,
): SessionSnapshot {
  return {
    sessionId,
    eventId,
    streamName,
    status,
    srsClientId: null,
    width: width ?? null,
    height: height ?? null,
    fps: fps ?? null,
    bitrateKbps: bitrateKbps ?? null,
    compliant,
    rejectReason: null,
    startedAt,
    endedAt: endedAt ?? null,
  }
}

function buildRecordingSnapshot(id: number, payload: RecordingReadyPayload): RecordingSnapshot {
  return {
    id,
    eventId: payload.eventId ?? null,
    sessionId: payload.sessionId ?? null,
    streamName: payload.streamName,
    studentLabel: null,
    filePath: payload.segments[0]?.relPath ?? '',
    sizeBytes: payload.sizeBytes,
    durationSec: payload.durationSec,
    startedAt: Date.now() - payload.durationSec * 1000,
  }
}
