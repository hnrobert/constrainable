/**
 * WebSocket control transport for media nodes — the protobuf Envelope
 * protocol (proto/control/v1/control.proto, one Envelope per binary frame).
 * Coexists with the legacy socket.io /media-node namespace during the fleet
 * cutover: the node picks its client side via CONTROL_TRANSPORT, and both
 * transports call the same handlers (media-node-handlers.ts).
 *
 * Also hosts the dual-transport send helpers (kick / recording cancel /
 * delete / WHEP / rec-pull) used by API call sites: WebSocket when the node
 * is connected here, legacy socket.io otherwise.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  EnvelopeSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  ErrorSchema,
  HelloAckSchema,
  HeartbeatAckSchema,
  CMsgLimitsSchema,
  LimitsConfigMessageSchema,
  AuthorizePublishResponseSchema,
  JudgeSpecResponseSchema,
  AuthSaltResponseSchema,
  AuthVerifyResponseSchema,
  AuthPolicyResponseSchema,
  WhepRelayRequestSchema,
  RecordingPullRequestSchema,
} from '#shared/proto/control/v1/control_pb'
import type { Envelope, RpcRequest, RpcResponse } from '#shared/proto/control/v1/control_pb'
import { env } from '../utils/env'
import { getSocket } from './media-node-registry'
import { getSocketIO } from '../utils/socket-io'
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
} from './media-node-handlers'

/** structural slice of crossws Peer — keeps this module independent of
 *  crossws' type resolution while the route handler passes the real thing. */
export interface WsPeer {
  id: string
  send: (data: string | Uint8Array) => unknown
  close: (code?: number, reason?: string) => unknown
}

const HELLO_TIMEOUT_MS = 10_000
/** mirrors engine.io ping interval × the Go read deadline / REMOTE_STALE_MS */
const IDLE_TIMEOUT_MS = 90_000
const WHEP_RPC_TIMEOUT_MS = 8_000
const REC_PULL_RPC_TIMEOUT_MS = 3_000

interface PendingRpc {
  resolve: (body: RpcResponse['body']) => void
  reject: (err: Error) => void
}

interface WsConn {
  peer: WsPeer
  nodeId: string | null
  sendQueue: Promise<void>
  idleTimer: ReturnType<typeof setTimeout>
  helloTimer: ReturnType<typeof setTimeout> | null
  pending: Map<number, PendingRpc>
}

const conns = new Map<string, WsConn>() // peerId → conn
const byNode = new Map<string, WsConn>() // nodeId → conn (last Hello wins)
let nextSeq = 1

/** All outbound frames chain on sendQueue — one logical writer per peer, so
 *  a 256KiB recording chunk can never interleave with a heartbeat ack. */
function enqueue(conn: WsConn, env1: Envelope): void {
  conn.sendQueue = conn.sendQueue
    .then(async () => {
      await conn.peer.send(toBinary(EnvelopeSchema, env1))
    })
    .catch((err) => {
      console.error('[media-ws] send failed, closing:', err)
      conn.peer.close(1011)
    })
}

function touchIdle(conn: WsConn): void {
  clearTimeout(conn.idleTimer)
  conn.idleTimer = setTimeout(() => {
    console.log(`[media-ws] idle timeout: ${conn.nodeId ?? conn.peer.id}`)
    conn.peer.close(4004, 'idle timeout')
  }, IDLE_TIMEOUT_MS)
}

function dropPending(conn: WsConn, err: Error): void {
  for (const p of conn.pending.values()) p.reject(err)
  conn.pending.clear()
}

export function onWsOpen(peer: WsPeer): void {
  const conn: WsConn = {
    peer,
    nodeId: null,
    sendQueue: Promise.resolve(),
    idleTimer: setTimeout(() => peer.close(4004, 'idle timeout'), IDLE_TIMEOUT_MS),
    helloTimer: setTimeout(() => {
      console.log('[media-ws] no hello within 10s, closing:', peer.id)
      peer.close(4002, 'hello timeout')
    }, HELLO_TIMEOUT_MS),
    pending: new Map(),
  }
  conns.set(peer.id, conn)
  console.log(`[media-ws] peer connected: ${peer.id}`)
}

export function onWsClose(peer: WsPeer): void {
  const conn = conns.get(peer.id)
  if (!conn) return
  conns.delete(peer.id)
  clearTimeout(conn.idleTimer)
  if (conn.helloTimer) clearTimeout(conn.helloTimer)
  dropPending(conn, new Error('node websocket closed'))
  if (conn.nodeId && byNode.get(conn.nodeId) === conn) {
    byNode.delete(conn.nodeId)
    // registry disconnect (lazy import: registry → handlers has no ws edge,
    // but keep this module importable from anywhere without cycles)
    import('./media-node-registry')
      .then(({ disconnect }) => {
        disconnect(peer.id)
        return import('./media-node-snapshot')
      })
      .then(({ emitNodesChanged }) => emitNodesChanged())
      .catch(() => {})
  }
  console.log(`[media-ws] peer closed: ${peer.id} (node ${conn.nodeId ?? '?'})`)
}

export async function onWsMessage(peer: WsPeer, data: Uint8Array): Promise<void> {
  const conn = conns.get(peer.id)
  if (!conn) return
  touchIdle(conn)

  let env1: Envelope
  try {
    env1 = fromBinary(EnvelopeSchema, data)
  } catch (err) {
    console.error('[media-ws] undecodable frame, closing:', err)
    peer.close(4003, 'bad envelope')
    return
  }

  const kind = env1.kind
  if (!kind) return

  switch (kind.case) {
    case 'hello': {
      if (conn.nodeId) return // duplicate hello on an authed conn — ignore
      const hello = kind.value
      if (!tokenOk(hello.authToken)) {
        console.warn('[media-ws] unauthorized hello, closing:', peer.id)
        peer.close(4001, 'unauthorized')
        return
      }
      const e = hello.endpoints
      const r = handleRegister(peer, {
        identifier: hello.identifier || hello.hostname,
        hostname: hello.hostname,
        version: hello.version,
        srsFlvBase: e?.srsFlvBase || undefined,
        publicOrigin: e?.publicOrigin || undefined,
        publicRtmpPort: e?.publicRtmpPort || undefined,
        publicProbeUdpPort: e?.publicProbeUdpPort || undefined,
        publicSrsUdpPort: e?.publicSrsUdpPort || undefined,
      })
      conn.nodeId = r.nodeId
      if (conn.helloTimer) {
        clearTimeout(conn.helloTimer)
        conn.helloTimer = null
      }
      // a reconnecting node replaces its stale connection explicitly
      const prev = byNode.get(r.nodeId)
      if (prev && prev !== conn) {
        prev.peer.close(4000, 'superseded by new connection')
      }
      byNode.set(r.nodeId, conn)
      enqueue(
        conn,
        create(EnvelopeSchema, {
          kind: { case: 'helloAck', value: create(HelloAckSchema, { nodeId: r.nodeId }) },
        }),
      )
      enqueue(
        conn,
        create(EnvelopeSchema, {
          kind: {
            case: 'limitsConfig',
            value: create(LimitsConfigMessageSchema, {
              global: create(CMsgLimitsSchema, r.limitsConfig.global),
              events: [],
            }),
          },
        }),
      )
      return
    }

    case 'heartbeat': {
      enqueue(
        conn,
        create(EnvelopeSchema, {
          kind: {
            case: 'heartbeatAck',
            value: create(HeartbeatAckSchema, { echoedSentAtMs: kind.value.sentAtMs }),
          },
        }),
      )
      return
    }

    case 'rpcRequest': {
      void handleRpcRequest(conn, kind.value).then((body) => {
        enqueue(
          conn,
          create(EnvelopeSchema, {
            kind: {
              case: 'rpcResponse',
              value: create(RpcResponseSchema, { seq: kind.value.seq, body }),
            },
          }),
        )
      })
      return
    }

    case 'rpcResponse': {
      const p = conn.pending.get(kind.value.seq)
      if (p) {
        conn.pending.delete(kind.value.seq)
        const body = kind.value.body
        if (body?.case === 'error') p.reject(new Error(body.value.message))
        else p.resolve(body ?? { case: 'error', value: create(ErrorSchema, { message: 'empty response' }) })
      }
      return
    }

    case 'publishMetrics':
    case 'publishViolation':
    case 'publishEnded':
    case 'recordingReady':
    case 'recordingChunk':
    case 'recordingStreamEnd':
      await handleEventIn(conn, kind)
      return

    case 'limitsConfig':
    case 'kickStream':
    case 'recordingCancel':
    case 'recordingDelete':
      // app -> node only; receiving them is a protocol oddity, not fatal
      console.warn(`[media-ws] node ${conn.nodeId ?? '?'} sent outbound-only frame: ${kind.case}`)
      return

    default:
      // helloAck / heartbeatAck from a node — nothing to do
      return
  }
}

function tokenOk(token: string): boolean {
  if (env.mediaNodeAuthToken === '') return true // no token configured → open access (parity with socket.io)
  const a = createHash('sha256').update(token).digest()
  const b = createHash('sha256').update(env.mediaNodeAuthToken).digest()
  return timingSafeEqual(a, b)
}

/** node → app RPCs. The node owns the timeout; we just answer. */
async function handleRpcRequest(_conn: WsConn, req: RpcRequest): Promise<RpcResponse['body']> {
  const body = req.body
  if (!body) return { case: 'error', value: create(ErrorSchema, { message: 'empty rpc body' }) }
  switch (body.case) {
    case 'authorizePublish': {
      const v = body.value
      const r = await handlePublishStart({
        nodeId: v.nodeId,
        streamName: v.streamName,
        token: v.token,
        authedUser: v.authedUser,
        srsClientId: v.srsClientId,
      })
      return {
        case: 'authorizePublish',
        value: create(AuthorizePublishResponseSchema, {
          allow: r.allow,
          reason: r.reason ?? '',
          sessionId: BigInt(r.sessionId ?? 0),
          eventId: r.eventId != null ? BigInt(r.eventId) : undefined,
          eventKey: r.eventKey ?? '',
          limits: r.limits ? create(CMsgLimitsSchema, r.limits) : undefined,
          record: r.record ?? false,
          strict: r.strict ?? false,
          measured: r.measured ?? false,
        }),
      }
    }
    case 'judgeSpec': {
      const v = body.value
      const verdict = await new Promise<{ allow: boolean; reason?: string }>((resolve) => {
        handleSpec(
          {
            nodeId: v.nodeId,
            streamName: v.streamName,
            width: v.width ?? 0,
            height: v.height ?? 0,
            fps: v.fps ?? 0,
            videoKbps: v.videoKbps ?? 0,
            audioBitrateKbps: v.audioBitrateKbps ?? 0,
          },
          resolve,
        )
      })
      return { case: 'judgeSpec', value: create(JudgeSpecResponseSchema, verdict) }
    }
    case 'authSalt':
      return { case: 'authSalt', value: create(AuthSaltResponseSchema, handleAuthSalt({ email: body.value.email })) }
    case 'authVerify': {
      const v = body.value
      return {
        case: 'authVerify',
        value: create(
          AuthVerifyResponseSchema,
          handleAuthVerify(_conn.nodeId, {
            email: v.email,
            opaque: v.opaque,
            challenge: v.challenge,
            response: v.response,
          }),
        ),
      }
    }
    case 'authPolicy': {
      const v = body.value
      return {
        case: 'authPolicy',
        value: create(AuthPolicyResponseSchema, handleAuthPolicy({ token: v.token, stream: v.stream })),
      }
    }
    default:
      return { case: 'error', value: create(ErrorSchema, { message: `unsupported rpc: ${body.case}` }) }
  }
}

/** node → app fire-and-forget frames (flattened Envelope kinds — the oneof
 *  case is the dispatch name, the protobuf equivalent of a hub method). */
async function handleEventIn(conn: WsConn, kind: NonNullable<Envelope['kind']>): Promise<void> {
  switch (kind.case) {
    case 'publishMetrics': {
      const v = kind.value
      handleMetrics({
        sessionId: Number(v.sessionId),
        width: v.width ?? undefined,
        height: v.height ?? undefined,
        fps: v.fps ?? undefined,
        videoBitrateKbps: v.videoBitrateKbps ?? undefined,
        audioBitrateKbps: v.audioBitrateKbps ?? undefined,
      })
      return
    }
    case 'publishViolation': {
      const v = kind.value
      handleViolation({
        sessionId: Number(v.sessionId),
        reasons: [...v.reasons],
        metrics: v.metrics
          ? {
              sessionId: Number(v.metrics.sessionId),
              width: v.metrics.width ?? undefined,
              height: v.metrics.height ?? undefined,
              fps: v.metrics.fps ?? undefined,
              videoBitrateKbps: v.metrics.videoBitrateKbps ?? undefined,
              audioBitrateKbps: v.metrics.audioBitrateKbps ?? undefined,
            }
          : undefined,
      })
      return
    }
    case 'publishEnded': {
      const v = kind.value
      handleEnd({ sessionId: Number(v.sessionId), endedAt: Number(v.endedAtMs), durationSec: v.durationSec })
      return
    }
    case 'recordingReady': {
      const v = kind.value
      handleRecordingReady({
        nodeId: v.nodeId,
        streamName: v.streamName,
        eventId: v.eventId != null ? Number(v.eventId) : null,
        sessionId: v.sessionId != null ? Number(v.sessionId) : undefined,
        segments: v.segments.map((s) => ({
          relPath: s.relPath,
          sizeBytes: Number(s.sizeBytes),
          durationSec: s.durationSec,
        })),
        sizeBytes: Number(v.sizeBytes),
        durationSec: v.durationSec,
        avgFps: v.avgFps ?? undefined,
        width: v.width ?? undefined,
        height: v.height ?? undefined,
      })
      return
    }
    case 'recordingChunk': {
      // lazy import: recordings.ts imports this module's rpc helpers — a
      // static edge back would be a cycle
      const { dispatchRecChunk } = await import('./recordings')
      dispatchRecChunk({ reqId: kind.value.reqId, data: kind.value.data })
      return
    }
    case 'recordingStreamEnd': {
      const { dispatchRecEnd } = await import('./recordings')
      dispatchRecEnd({ reqId: kind.value.reqId, error: kind.value.error || undefined })
      return
    }
    default:
      return
  }
}

/* ------------------- app → node: dual-transport helpers ------------------- */

export function wsConnected(nodeId: string): boolean {
  return byNode.has(nodeId)
}

/** app → node RPC over the WS transport (caller falls back to socket.io). */
function rpcCall(conn: WsConn, body: RpcRequest['body'], timeoutMs: number): Promise<RpcResponse['body']> {
  const seq = nextSeq++
  return new Promise<RpcResponse['body']>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(seq)
      reject(new Error('node rpc timeout'))
    }, timeoutMs)
    conn.pending.set(seq, {
      resolve: (b) => {
        clearTimeout(timer)
        resolve(b)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      },
    })
    enqueue(
      conn,
      create(EnvelopeSchema, {
        kind: { case: 'rpcRequest', value: create(RpcRequestSchema, { seq, body }) },
      }),
    )
  })
}

/** Relay a WHEP SDP offer to the node's colocated SRS over the WS transport. */
export async function wsRpcWhepRelay(nodeId: string, streamName: string, offerSdp: Uint8Array): Promise<Uint8Array> {
  const conn = byNode.get(nodeId)
  if (!conn) throw new Error('not connected via websocket')
  const body = await rpcCall(
    conn,
    { case: 'whepRelay', value: create(WhepRelayRequestSchema, { streamName, offerSdp }) },
    WHEP_RPC_TIMEOUT_MS,
  )
  if (body.case === 'error') throw new Error(`node: ${body.value.message}`)
  if (body.case !== 'whepRelay') throw new Error('unexpected rpc response')
  if (body.value.error) throw new Error(`node SRS: ${body.value.error}`)
  if (body.value.answerSdp.length === 0) throw new Error('node returned an empty WHEP answer')
  return body.value.answerSdp
}

/** Start a recording-file transfer over the WS transport. */
export async function wsRpcRecordingPull(nodeId: string, reqId: string, relPath: string): Promise<boolean> {
  const conn = byNode.get(nodeId)
  if (!conn) throw new Error('not connected via websocket')
  const body = await rpcCall(
    conn,
    { case: 'recordingPull', value: create(RecordingPullRequestSchema, { reqId, relPath }) },
    REC_PULL_RPC_TIMEOUT_MS,
  )
  if (body.case === 'error') throw new Error(`node: ${body.value.message}`)
  if (body.case !== 'recordingPull') throw new Error('unexpected rpc response')
  return body.value.started
}

/** the app → node push frames this module originates (init shapes — create()
 *  fills the message) */
type PushKind =
  | { case: 'kickStream'; value: { streamName: string; reason: string } }
  | { case: 'recordingCancel'; value: { reqId: string } }
  | { case: 'recordingDelete'; value: { relPaths: string[] } }

function wsSendKind(nodeId: string, kind: PushKind): boolean {
  const conn = byNode.get(nodeId)
  if (!conn) return false
  enqueue(conn, create(EnvelopeSchema, { kind }))
  return true
}

function legacySocket(nodeId: string) {
  const io = getSocketIO()
  return io ? getSocket(io, nodeId) : null
}

/** Kick a stream: WS nodes via kick_stream, socket.io nodes via node:kick. */
export function kickStream(nodeId: string, streamName: string, reason: string): boolean {
  if (wsSendKind(nodeId, { case: 'kickStream', value: { streamName, reason } })) {
    return true
  }
  const socket = legacySocket(nodeId)
  if (!socket) return false
  socket.emit('node:kick', { streamName, reason })
  return true
}

/** Cancel an in-flight recording transfer (stall watchdog). */
export function cancelRecordingPull(nodeId: string, reqId: string): void {
  if (wsSendKind(nodeId, { case: 'recordingCancel', value: { reqId } })) return
  legacySocket(nodeId)?.emit('node:rec:stop', { reqId })
}

/** Tell a node to delete recording files on its disk (app can't see them). */
export function sendRecordingDelete(nodeId: string, relPaths: string[]): boolean {
  if (wsSendKind(nodeId, { case: 'recordingDelete', value: { relPaths } })) {
    return true
  }
  const socket = legacySocket(nodeId)
  if (!socket) return false
  socket.emit('recording:delete', { segments: relPaths })
  return true
}
