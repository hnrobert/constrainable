/**
 * Socket.IO wiring for the /media-node namespace — the LEGACY transport for
 * Go media nodes, kept during the fleet cutover to the protobuf WebSocket
 * (services/media-node-ws.ts; node-side CONTROL_TRANSPORT picks the client).
 * All handler logic lives in media-node-handlers.ts, shared by both
 * transports; this file only translates the socket.io wire format.
 */
import type { Server as SocketIOServer } from 'socket.io'
import { env } from '../utils/env'
import { disconnect } from './media-node-registry'
import { emitNodesChanged } from './media-node-snapshot'
import { dispatchRecChunk, dispatchRecEnd } from './recordings'
import {
  handleRegister,
  handlePublishStart,
  handleMetrics,
  handleEnd,
  handleRecordingReady,
  handleSpec,
  handleViolation,
  handleAuthSalt,
  handleAuthVerify,
  handleAuthPolicy,
  nodeIdOfSocket,
  type RegisterInfo,
  type PublishStartPayload,
  type PublishAuthorizedAck,
  type MetricsPayload,
  type SpecPayload,
  type EndPayload,
  type RecordingReadyPayload,
  type ViolationPayload,
} from './media-node-handlers'

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
      const info: RegisterInfo = {
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
      }
      const r = handleRegister(socket, info)
      // Push current limits config to the node
      socket.emit('config:limits', { global: r.limitsConfig.global, events: [] })
      ack?.({ nodeId: r.nodeId })
      // The node registers WITHOUT an ack callback (fire-and-forget frame) —
      // it learns its assigned nodeId from this event. Without it c.nodeID
      // stays "" and every publish:start arrives with an empty nodeId.
      socket.emit('node:registered', { nodeId: r.nodeId })
    })

    socket.on('publish:start', async (payload: PublishStartPayload, ack?: (r: PublishAuthorizedAck) => void) => {
      ack?.(await handlePublishStart(payload))
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

    // recording-file relay delivery (see services/recordings.ts — downloads).
    // base64 on this legacy wire; the hub (and the WS transport) work in bytes.
    socket.on('node:rec:data', (payload: { reqId?: string; data?: string }) => {
      dispatchRecChunk({
        reqId: payload?.reqId,
        data: payload?.data ? new Uint8Array(Buffer.from(payload.data, 'base64')) : undefined,
      })
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
      ack?.(handleAuthSalt(p))
    })

    socket.on(
      'auth:verify',
      (
        p: { email?: string; opaque?: string; challenge?: string; response?: string },
        ack?: (r: { allow: boolean; known: boolean }) => void,
      ) => {
        ack?.(handleAuthVerify(nodeIdOfSocket(socket.id), p))
      },
    )

    socket.on(
      'auth:policy',
      (
        p: { token?: string; stream?: string },
        ack?: (r: { publishKey: boolean; requireAccountAuth: boolean; windowOpen: boolean; banned: boolean }) => void,
      ) => {
        ack?.(handleAuthPolicy(p))
      },
    )
  })
}
