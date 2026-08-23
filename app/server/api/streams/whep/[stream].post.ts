/**
 * Same-origin WHEP (WebRTC) signaling proxy — the SDP exchange only. The
 * browser POSTs its offer here; we forward it to the hosting SRS's
 * /rtc/v1/whep/ endpoint and return the answer. Same-origin keeps JWT auth +
 * no CORS, and removes any need for SRS's API port to be browser-visible —
 * only the MEDIA (ICE/UDP) still flows browser↔SRS directly, which is the
 * point of WebRTC. Admin-only, like the FLV proxy.
 *
 * Two forwarding paths by host:
 *   - REMOTE media node: the node's SRS HTTP API is deliberately NEVER
 *     published (unauthenticated), so the offer is RELAYED over the socket.io
 *     control channel ('node:whep' with ack — the node POSTs to its colocated
 *     SRS itself). Requires firmware with the handler; older binaries never
 *     ack → a clear 502 telling the admin to update the node.
 *   - Local SRS (single-server): direct internal fetch, as before.
 */
import { createError, getRouterParam } from 'h3'
import { env } from '../../../utils/env'
import { resolveFlvBase, getHostingNode, getSocket } from '../../../services/media-node-registry'
import { getSocketIO } from '../../../utils/socket-io'
import { getAuth } from '../../../utils/auth'
import { UsersRepository } from '../../../repositories/users.repository'
import { PublishSessionsRepository } from '../../../repositories/publish-sessions.repository'

const NODE_WHEP_TIMEOUT_MS = 8000

export default defineEventHandler(async (event) => {
  // admin: any stream; regular user: only their own (account email = stream
  // name — the /live self-view rides on this)
  const auth = getAuth(event)
  if (!auth) throw createError({ statusCode: 403, statusMessage: 'login required' })
  const stream = decodeURIComponent(String(getRouterParam(event, 'stream') ?? '')).trim()
  if (!stream || stream.includes('/')) {
    throw createError({ statusCode: 400, statusMessage: 'stream is required' })
  }
  if (auth.role !== 'admin') {
    const ownEmail = UsersRepository.findById(auth.userId)?.email
    if (stream !== ownEmail) {
      throw createError({ statusCode: 403, statusMessage: 'you can only watch your own stream' })
    }
  }
  const offer = await readRawBody(event)
  if (!offer) {
    throw createError({ statusCode: 400, statusMessage: 'SDP offer body is required' })
  }

  // Which side holds the stream? An ACTIVE session decides; without one the
  // stream is not live anywhere — say so plainly instead of falling through
  // to the local SRS and reporting a confusing "endpoint not reachable".
  const session = PublishSessionsRepository.findActiveByStream(stream)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'stream is not live' })
  }
  // Remote-hosted stream → relay the SDP through the node's control socket.
  const host = getHostingNode(stream)
  if (host) {
    const io = getSocketIO()
    const socket = io ? getSocket(io, host.nodeId) : null
    if (!socket) {
      throw createError({ statusCode: 502, statusMessage: 'hosting node is offline' })
    }
    const answer = await new Promise<string>((resolve, reject) => {
      socket
        .timeout(NODE_WHEP_TIMEOUT_MS)
        .emit(
          'node:whep',
          { streamName: stream, offer },
          (err: unknown, res: { answer?: string; error?: string } | undefined) => {
            if (err) {
              reject(createError({
                statusCode: 502,
                statusMessage: 'node did not answer the WHEP relay (old firmware?) — update the node',
              }))
            } else if (res?.error) {
              reject(createError({ statusCode: 502, statusMessage: `node SRS: ${res.error}` }))
            } else if (res?.answer) {
              resolve(res.answer)
            } else {
              reject(createError({ statusCode: 502, statusMessage: 'node returned an empty WHEP answer' }))
            }
          },
        )
    })
    setHeader(event, 'content-type', 'application/sdp')
    setHeader(event, 'cache-control', 'no-store')
    return answer
  }

  // Local SRS: it serves both the FLV remux and the HTTP API from the same
  // host — swap the FLV base's port for the API port.
  const target = new URL(resolveFlvBase(stream))
  target.port = String(env.srsApiPort)
  target.pathname = '/rtc/v1/whep/'
  target.search = `?app=live&stream=${encodeURI(stream)}`

  let resp: Response
  try {
    // @-bearing stream names: keep the resource encoding identical to the
    // FLV paths (encodeURI, @ verbatim)
    resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offer,
    })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'WHEP endpoint not reachable (stream live?)' })
  }
  if (!resp.ok) {
    throw createError({ statusCode: 502, statusMessage: `SRS WHEP responded ${resp.status}` })
  }

  setHeader(event, 'content-type', 'application/sdp')
  setHeader(event, 'cache-control', 'no-store')
  return await resp.text()
})
