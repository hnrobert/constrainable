/**
 * Socket.IO event handlers for the /media-nodes namespace — the control-plane
 * side of the Go media-node connection. Handles node registration, publish
 * authorization (ack-based), session metrics, stream end, recording reports,
 * and violation alerts. All dashboard events go through the existing bus so
 * the frontend needs zero changes to see remote sessions.
 */
import type { Server as SocketIOServer, Socket } from 'socket.io'
import { env } from '../utils/env'
import { register, disconnect, adjustStreamCount, getNode, emitToNode } from './media-node-registry'
import { authorizePublish } from './access-control'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import { RecordingsRepository } from '../repositories/recordings.repository'
import { getConfig, getLimitsFor } from '../utils/config-store'
import { EventsRepository } from '../repositories/events.repository'
import { UsersRepository } from '../repositories/users.repository'
import { isSiteWideBanned, isBlocked, ban, liftStrictLimitsBan } from './stream-bans'
import { verifierFromCipher, verifyResponse } from '../utils/authmod'
import { obsServerUrl } from '#shared/rtmp'
import { audit } from './audit'
import { emit } from '../utils/bus'
import { emitNodesChanged } from './media-node-snapshot'
import type { PublishSession } from '../database/schema'
import type { SessionSnapshot, SessionStatus, RecordingSnapshot } from '#shared/events'

interface RegisterPayload {
  identifier: string
  publicRtmpAuthority?: string
  rtmpPort: number
  srtPort: number
  srsFlvBase?: string
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

interface SpecPayload {
	nodeId: string
	streamName: string
	width: number
	height: number
	fps: number
	videoKbps: number
	audioKbps: number
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
        identifier: payload.identifier,
        publicRtmpAuthority: payload.publicRtmpAuthority ?? '',
        rtmpPort: payload.rtmpPort,
        srtPort: payload.srtPort,
        srsFlvBase: payload.srsFlvBase,
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
      // The node registers WITHOUT an ack callback (fire-and-forget frame) —
      // it learns its assigned nodeId from this event. Without it c.nodeID
      // stays "" and every publish:start arrives with an empty nodeId.
      socket.emit('node:registered', { nodeId })
      emitNodesChanged()
    })

    socket.on('publish:start', async (payload: PublishStartPayload, ack?: (r: PublishAuthorizedAck) => void) => {
      const result = await handlePublishStart(socket, payload)
      ack?.(result)
    })

    socket.on('publish:metrics', (payload: MetricsPayload) => {
      handleMetrics(payload)
    })

    socket.on('publish:spec', (payload: SpecPayload) => {
      handleSpec(payload)
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
      emitNodesChanged()
    })


    // --- RTMP auth (Adobe authmod) — the media-node's ONLY auth surface. The
    // same logic as the HTTP /api/srs/rtmp-auth endpoints (which remain for
    // tooling), but carried over the socket with acks. The namespace itself is
    // token-gated, so no per-call secret is needed. ---

    socket.on('auth:salt', (p: { email?: string }, ack?: (r: { salt: string; banned: boolean }) => void) => {
      const email = String(p?.email ?? '').trim().toLowerCase()
      const user = email ? UsersRepository.findByEmail(email) : undefined
      // Unknown users get a random salt — byte-identical challenge, no enumeration
      ack?.({
        salt: user?.authmodSalt || crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        banned: !!email && isSiteWideBanned(email),
      })
    })

    socket.on(
      'auth:verify',
      (
        p: { email?: string; opaque?: string; challenge?: string; response?: string },
        ack?: (r: { allow: boolean; known: boolean }) => void,
      ) => {
        const email = String(p?.email ?? '').trim().toLowerCase()
        const user = email ? UsersRepository.findByEmail(email) : undefined
        if (!user?.authmodVerifier) {
          // Unknown username: placeholder credentials, not a hard auth failure
          ack?.({ allow: false, known: false })
          return
        }
        const ok = verifyResponse({
          storedVerifier: verifierFromCipher(user.authmodVerifier),
          opaque: String(p?.opaque ?? ''),
          challenge: String(p?.challenge ?? ''),
          response: String(p?.response ?? ''),
        })
        // known + !allow = a real account with the wrong password → the node
        // refuses the connection outright (librtmp-fatal `authfailed`)
        ack?.({ allow: ok, known: true })
      },
    )

    socket.on(
      'auth:policy',
      (
        p: { token?: string; stream?: string },
        ack?: (r: { publishKey: boolean; requireAccountAuth: boolean; windowOpen: boolean; banned: boolean }) => void,
      ) => {
        const token = String(p?.token ?? '')
        const stream = String(p?.stream ?? '').trim()
        const row = token ? EventsRepository.findByPublishKey(token) : undefined
        const now = Date.now()
        const windowOpen =
          !row || row.status === 'archived'
            ? true
            : (!row.startsAt || now >= row.startsAt.getTime()) &&
              (!row.endsAt || now <= row.endsAt.getTime())
        ack?.({
          publishKey: !!row,
          requireAccountAuth: true,
          windowOpen: row?.status === 'archived' ? false : windowOpen,
          banned: !!stream && isBlocked(stream, row?.id ?? null),
        })
      },
    )
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
        actor: payload.streamName,
        streamName: payload.streamName,
        detail: { reason: auth.reason, nodeId: payload.nodeId },
      })
      return { allow: false, reason: auth.reason }
    }

    // Node lock: a user who explicitly selected (or was assigned) a node may
    // ONLY publish through THAT node — a publish arriving from any other
    // node is refused with the address they should be using.
    const lockUser = UsersRepository.findByEmail(payload.streamName)
    if (lockUser?.nodeId && payload.nodeId && lockUser.nodeId !== payload.nodeId) {
      const pinned = getNode(lockUser.nodeId)
      const where = pinned?.publicRtmpAuthority
        ? ` — use ${obsServerUrl(pinned.publicRtmpAuthority)} (or change your selection on the Nodes page)`
        : ' — check the Nodes page on the website for your node address'
      audit('warn', 'access', `publish on wrong node: ${payload.streamName} (${payload.nodeId}, locked to ${lockUser.nodeId})`, {
        actor: payload.streamName,
        streamName: payload.streamName,
        detail: { nodeId: payload.nodeId, lockedTo: lockUser.nodeId },
      })
      return { allow: false, reason: `streaming is locked to your selected node${where}` }
    }

    // Determine event limits + recording flag
    const event = auth.eventId ? EventsRepository.findById(auth.eventId) : null
    const limits = getLimitsFor(event)
    const cfg = getConfig()
    const record = cfg.record.enabled && (event?.recordEnabled ?? true)

    // Insert the session row (nodeId marks it as a remote media-node session —
    // the playback proxy and kick routing key off it)
    const row = PublishSessionsRepository.insert({
      eventId: auth.eventId ?? null,
      streamKeyId: auth.streamKeyId > 0 ? auth.streamKeyId : null,
      streamName: payload.streamName,
      nodeId: payload.nodeId,
      srsClientId: payload.srsClientId || null,
      status: 'allowed',
      startedAt: new Date(),
    })

    adjustStreamCount(payload.nodeId, 1)
    emitNodesChanged()

    // Emit session:start to the dashboard via the bus
    emit('session:start', snapshotFromRow(row))

    audit('info', 'publish', `media-node publish started: ${payload.streamName}`, {
      actor: payload.streamName,
      eventId: auth.eventId ?? null,
      streamName: payload.streamName,
      detail: { nodeId: payload.nodeId, sessionId: row.id },
    })

    return {
      allow: true,
      sessionId: row.id,
      eventId: auth.eventId ?? null,
      // Declared-spec enforcement happens HERE (publish:spec handler) and is
      // unconditional. The MEASURED check runs on the node — hand it the
      // limits only when this event opts in; otherwise the node collects
      // metrics without ever reporting violations.
      limits: event?.enforceMeasuredLimits
        ? {
            maxWidth: limits.maxWidth,
            maxHeight: limits.maxHeight,
            maxFps: limits.maxFps,
            maxBitrateKbps: limits.maxBitrateKbps,
          }
        : undefined,
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
  emit('session:metric', snapshotFromRow(row, {
    width: payload.width ?? row.width,
    height: payload.height ?? row.height,
    fps: payload.fps ?? row.fps,
    bitrateKbps: payload.bitrateKbps ?? row.bitrateKbps,
  }))
}

function handleEnd(payload: EndPayload): void {
  const row = PublishSessionsRepository.findById(payload.sessionId)
  if (!row) return
  const finalStatus: SessionStatus = row.compliant ? 'compliant' : 'ended'
  PublishSessionsRepository.markEnded(payload.sessionId, finalStatus, new Date(payload.endedAt))
  emitNodesChanged()
  emit('session:stop', snapshotFromRow(row, { status: finalStatus, endedAt: payload.endedAt }))
  audit('info', 'publish', `media-node publish ended: ${row.streamName}`, {
    actor: row.streamName,
    eventId: row.eventId ?? null,
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

/**
 * OBS' DECLARED spec from onMetaData — arrives right after publish accepts,
 * before the first frame. Shows the spec instantly AND runs the limit check
 * immediately (strict events punish before a single frame is served). The
 * measured counters remain the ongoing authority (declared values can be
 * forged by a custom publisher).
 */
function handleSpec(payload: SpecPayload): void {
  const row = PublishSessionsRepository.findById(
    PublishSessionsRepository.findActiveByStream(payload.streamName)?.id ?? -1,
  )
  if (!row) return
  const bitrateKbps = Math.round((payload.videoKbps || 0) + (payload.audioKbps || 0))
  PublishSessionsRepository.updateMetrics(row.id, {
    width: payload.width || row.width,
    height: payload.height || row.height,
    fps: payload.fps || row.fps,
    bitrateKbps: bitrateKbps || row.bitrateKbps,
  })
  emit('session:metric', {
    ...snapshotFromRow(row, {
      width: payload.width || row.width,
      height: payload.height || row.height,
      fps: payload.fps || row.fps,
      bitrateKbps: bitrateKbps || row.bitrateKbps,
    }),
  })

  // immediate limit gate on the declared values
  const event = row.eventId ? EventsRepository.findById(row.eventId) : null
  const limits = getLimitsFor(event)
  const reasons: string[] = []
  if (limits.maxWidth > 0 && payload.width > limits.maxWidth) reasons.push('resolution exceeds limit')
  if (limits.maxHeight > 0 && payload.height > limits.maxHeight) reasons.push('resolution exceeds limit')
  if (limits.maxFps > 0 && payload.fps > limits.maxFps) reasons.push('fps exceeds limit')
  if (limits.maxBitrateKbps > 0 && bitrateKbps > limits.maxBitrateKbps) reasons.push('bitrate exceeds limit')
  if (reasons.length === 0) {
    // compliant after a previous violation — clear the auto ban so the Bans
    // panel doesn't show a stale entry (and reconnects are obviously clean)
    if (row.eventId != null) liftStrictLimitsBan(row.streamName, row.eventId)
    return
  }

  PublishSessionsRepository.updateStatus(row.id, 'violating')
  emit('session:violation', {
    ...snapshotFromRow(row, { status: 'violating' }),
    reasons,
  })
  if (event?.strictLimits) punishViolation(row, reasons)
}

/** strict-limits punishment: event-scoped ban + kill on the hosting node. */
function punishViolation(row: { id: number; eventId: number | null; streamName: string; nodeId: string | null }, reasons: string[]): void {
  const reasonText = reasons.join('; ')
  ban({
    email: row.streamName,
    eventId: row.eventId,
    reason: `strict limits violation: ${reasonText}`,
    bannedBy: 'system:strict-limits',
  })
  audit('warn', 'publish', `strict-limits ban: ${row.streamName} (${reasonText})`, {
    actor: row.streamName,
    eventId: row.eventId ?? null,
    streamName: row.streamName,
    detail: { sessionId: row.id, eventId: row.eventId, reasons },
  })
  const io = getSocketIO()
  if (io && row.nodeId) {
    emitToNode(io, row.nodeId, 'node:kick', {
      streamName: row.streamName,
      reason: `strict limits violation: ${reasonText}`,
    })
  }
}

function handleViolation(payload: ViolationPayload): void {
  const row = PublishSessionsRepository.findById(payload.sessionId)
  if (!row) return
  PublishSessionsRepository.updateStatus(payload.sessionId, 'violating')

  // STRICT limits: the event is configured to treat violations like a ban —
  // ban the publisher from THIS event (identical enforcement to a manual
  // ban: every reconnect is refused at the policy stage) and kill the
  // stream on its hosting node.
  const event = row.eventId ? EventsRepository.findById(row.eventId) : null
  if (event?.strictLimits) punishViolation(row, payload.reasons)
  audit('warn', 'publish', `media-node violation: ${row.streamName} (${payload.reasons.join('; ')})`, {
    actor: row.streamName,
    eventId: row.eventId ?? null,
    streamName: row.streamName,
    detail: { reasons: payload.reasons, nodeId: 'remote' },
  })
  emit('session:violation', {
    ...snapshotFromRow(row, {
      status: 'violating',
      width: payload.metrics?.width ?? row.width,
      height: payload.metrics?.height ?? row.height,
      fps: payload.metrics?.fps ?? row.fps,
      bitrateKbps: payload.metrics?.bitrateKbps ?? row.bitrateKbps,
    }),
    reasons: payload.reasons,
  })
}

// --- snapshot helpers ---

/** Build a dashboard snapshot from a session row, with live-metric overrides. */
function snapshotFromRow(
  row: PublishSession,
  over: {
    status?: SessionStatus
    width?: number | null
    height?: number | null
    fps?: number | null
    bitrateKbps?: number | null
    endedAt?: number | null
  } = {},
): SessionSnapshot {
  return {
    sessionId: row.id,
    eventId: row.eventId ?? null,
    streamName: row.streamName,
    status: over.status ?? (row.status as SessionStatus),
    srsClientId: row.srsClientId ?? null,
    nodeId: row.nodeId ?? null,
    width: over.width ?? row.width ?? null,
    height: over.height ?? row.height ?? null,
    fps: over.fps ?? row.fps ?? null,
    bitrateKbps: over.bitrateKbps ?? row.bitrateKbps ?? null,
    compliant: !!row.compliant,
    rejectReason: row.rejectReason ?? null,
    startedAt: row.startedAt.getTime(),
    endedAt: over.endedAt ?? null,
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
