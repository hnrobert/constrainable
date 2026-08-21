/**
 * Socket.IO event handlers for the /media-nodes namespace — the control-plane
 * side of the Go media-node connection. Handles node registration, publish
 * authorization (ack-based), session metrics, stream end, recording reports,
 * and violation alerts. All dashboard events go through the existing bus so
 * the frontend needs zero changes to see remote sessions.
 */
import type { Server as SocketIOServer, Socket } from 'socket.io'
import { env } from '../utils/env'
import { register, disconnect, adjustStreamCount, getNode, emitToNode, rtmpAuthority, listNodes } from './media-node-registry'
import { authorizePublish } from './access-control'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import { RecordingsRepository } from '../repositories/recordings.repository'
import { getConfig, getLimitsFor } from '../utils/config-store'
import { EventsRepository } from '../repositories/events.repository'
import { UsersRepository } from '../repositories/users.repository'
import { isSiteWideBanned, isBlocked } from './stream-bans'
import { verifierFromCipher, verifyResponse } from '../utils/authmod'
import { obsServerUrl } from '#shared/rtmp'
import { audit } from './audit'
import { emit } from '../utils/bus'
import { emitNodesChanged } from './media-node-snapshot'
import { dispatchRecChunk, dispatchRecEnd } from './recordings'
import type { PublishSession } from '../database/schema'
import type { SessionSnapshot, SessionStatus, RecordingSnapshot } from '#shared/events'

interface RegisterPayload {
  identifier: string
  /** pre-rename wire name still sent by older node binaries */
  origin?: string
  srsFlvBase?: string
  publicOrigin?: string
  publicRtmpPort?: number
  publicProbeUdpPort?: number
  publicSrsUdpPort?: number
  /** LEGACY pre-split field (host[:port]) still sent by older binaries */
  publicRtmpAuthority?: string
  hostname: string
  version: string
}

/** Old binaries send PUBLIC_RTMP_AUTHORITY (host[:port]) instead of the
 *  split PUBLIC_MEDIA_NODE_ORIGIN/PUBLIC_MEDIA_NODE_RTMP_PORT pair — normalize for register(). */
function splitLegacyAuthority(payload: RegisterPayload): {
  publicOrigin?: string
  publicRtmpPort?: number
} {
  if (payload.publicOrigin || !payload.publicRtmpAuthority) return {}
  const [host, portStr] = payload.publicRtmpAuthority.split(':')
  if (!host) return {}
  return { publicOrigin: host, publicRtmpPort: Number(portStr) || 1935 }
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
  limits?: { maxWidth: number; maxHeight: number; maxFps: number; maxVideoBitrateKbps: number; maxAudioBitrateKbps: number }
  record?: boolean
  /** strict events: the node rejects declared-spec violations locally (OBS-terminal) */
  strict?: boolean
  /** measured enforcement (5s deltas on the node's monitor) */
  measured?: boolean
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
        // identifier is the current field; origin is the pre-rename wire name
        // (mixed-version fleets during rollout). Hostname as last resort.
        identifier: payload.identifier || payload.origin || payload.hostname,
        srsFlvBase: payload.srsFlvBase,
        publicOrigin: payload.publicOrigin ?? '',
        publicRtmpPort: payload.publicRtmpPort ?? 1935,
        publicProbeUdpPort: payload.publicProbeUdpPort ?? 0,
        publicSrsUdpPort: payload.publicSrsUdpPort ?? 0,
        // legacy PUBLIC_RTMP_AUTHORITY (host[:port]) splits into origin+port
        // (only fills gaps — explicit new fields win)
        ...splitLegacyAuthority(payload),
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

    socket.on('publish:spec', (payload: SpecPayload, ack?: (r: { allow: boolean; reason?: string }) => void) => {
      handleSpec(payload, ack)
    })

    socket.on('publish:end', (payload: EndPayload) => {
      handleEnd(payload)
    })

    socket.on('recording:ready', (payload: RecordingReadyPayload) => {
      handleRecordingReady(payload)
    })

    // recording-file relay delivery (see services/recordings.ts — downloads)
    socket.on('node:rec:data', (payload: { reqId?: string; data?: string }) => {
      dispatchRecChunk(payload)
    })
    socket.on('node:rec:end', (payload: { reqId?: string; error?: string }) => {
      dispatchRecEnd(payload)
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
          // Unknown username: placeholder credentials, not a hard auth failure.
          // Audited for visibility, but NOT attributed to the attempted address
          // — the account doesn't exist and the string is untrusted input.
          audit('warn', 'auth', 'authmod failed: user does not exist', {
            detail: {
              attemptedEmail: email || null,
              nodeId: listNodes().find((n) => n.socketId === socket.id)?.nodeId ?? null,
            },
          })
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
        if (!ok) {
          audit('warn', 'auth', `authmod failed: wrong password (${email})`, {
            actor: email,
            detail: {
              email,
              nodeId: listNodes().find((n) => n.socketId === socket.id)?.nodeId ?? null,
            },
          })
        }
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
      const pinnedAuthority = pinned ? rtmpAuthority(pinned) : ''
      const where = pinnedAuthority
        ? ` — use ${obsServerUrl(pinnedAuthority)} (or change your selection on the Nodes page)`
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
      // Limits always travel with the grant: the node checks the DECLARED
      // spec against them locally when strict (metadata-time, OBS-terminal),
      // and runs the MEASURED 5s monitor against them when measured.
      limits: {
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxFps: limits.maxFps,
        maxVideoBitrateKbps: limits.maxVideoBitrateKbps,
        maxAudioBitrateKbps: limits.maxAudioBitrateKbps,
      },
      strict: event?.strictLimits ?? false,
      measured: event?.enforceMeasuredLimits ?? false,
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
      nodeId: payload.nodeId ?? null,
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
function handleSpec(payload: SpecPayload, ack?: (r: { allow: boolean; reason?: string }) => void): void {
  const row = PublishSessionsRepository.findById(
    PublishSessionsRepository.findActiveByStream(payload.streamName)?.id ?? -1,
  )
  if (!row) {
    ack?.({ allow: false, reason: 'no active session' })
    return
  }
  // Bitrate = the VIDEO rate only (OBS' "Video Bitrate" field) — limits and
  // the guides quote that number; adding the audio track inflated it
  // (100 kbps video + 160 kbps default audio read as 260).
  const bitrateKbps = Math.round(payload.videoKbps || 0)
  const audioKbps = Math.round(payload.audioKbps || 0)
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

  // Immediate limit gate on the declared values. The verdict goes back as an
  // ACK. STRICT events: the node rejects the connection exactly like a wrong
  // password (OBS-terminal BadName, zero frames relayed) — no ban recorded,
  // "wrong settings" is a client fix, not a violation to punish for; an
  // admin can still ban manually from the live panel. NON-strict events:
  // advisory only — the breach is flagged and shown on the dashboard, but
  // the stream continues (measured enforcement is the separate opt-in).
  const event = row.eventId ? EventsRepository.findById(row.eventId) : null
  const limits = getLimitsFor(event)
  const strict = event?.strictLimits ?? false
  const reasons = new Set<string>()
  if (limits.maxWidth > 0 && payload.width > limits.maxWidth) reasons.add('resolution exceeds limit')
  if (limits.maxHeight > 0 && payload.height > limits.maxHeight) reasons.add('resolution exceeds limit')
  if (limits.maxFps > 0 && payload.fps > limits.maxFps) reasons.add('fps exceeds limit')
  if (limits.maxVideoBitrateKbps > 0 && bitrateKbps > limits.maxVideoBitrateKbps) reasons.add('bitrate exceeds limit')
  if (limits.maxAudioBitrateKbps > 0 && audioKbps > limits.maxAudioBitrateKbps) {
    reasons.add('audio bitrate exceeds limit')
  }

  if (reasons.size === 0) {
    ack?.({ allow: true })
    return
  }

  const reasonList = [...reasons]
  PublishSessionsRepository.updateStatus(row.id, 'violating')
  emit('session:violation', {
    ...snapshotFromRow(row, { status: 'violating' }),
    reasons: reasonList,
  })
  audit('warn', 'publish', `spec ${strict ? 'rejected' : 'exceeds limits'}: ${row.streamName} (${reasonList.join('; ')})`, {
    actor: row.streamName,
    eventId: row.eventId ?? null,
    streamName: row.streamName,
    detail: { sessionId: row.id, strict, reasons: reasonList },
  })
  if (!strict) {
    ack?.({ allow: true })
    return
  }
  ack?.({ allow: false, reason: reasonList.join('; ') + '. Lower your OBS resolution/FPS/bitrate and reconnect.' })
}


function handleViolation(payload: ViolationPayload): void {
  const row = PublishSessionsRepository.findById(payload.sessionId)
  if (!row) return
  PublishSessionsRepository.updateStatus(payload.sessionId, 'violating')

  // MEASURED-limit violation (the node's 5s monitor): flag the session and
  // surface it on the dashboard. No ban — enforcement data is per-publish,
  // not a stored verdict; an admin can still ban manually from the panel.
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
