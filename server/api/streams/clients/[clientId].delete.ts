/**
 * Admin: ban a live publisher (site-wide) and disconnect them immediately.
 * The ban is permanent — lifted only from the blacklist UI. Disconnect routing
 * follows the session: remote media-node sessions get a `node:kick` over
 * Socket.IO (their node ends the stream); local sessions kill the SRS client
 * directly. Either way SRS fires on_unpublish, ending the session and
 * finalizing the recording. With the RTMP gateway in front, the OBS connection
 * tears down too, and every reconnect is refused at the dance (salt) stage.
 */
import { createError, getRouterParam } from 'h3'
import { killClient } from '../../../services/srs-client'
import { ban } from '../../../services/stream-bans'
import { audit } from '../../../services/audit'
import { emitToNode } from '../../../services/media-node-registry'
import { getSocketIO } from '../../../utils/socket-io'
import { PublishSessionsRepository } from '../../../repositories/publish-sessions.repository'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const clientId = getRouterParam(event, 'clientId')
  if (!clientId) throw createError({ statusCode: 400, statusMessage: 'clientId is required' })
  const email = String(getQuery(event).email || '').trim().toLowerCase()
  const reason = String(getQuery(event).reason || '').trim() || null

  if (!email) {
    throw createError({ statusCode: 400, statusMessage: 'email is required to ban' })
  }

  const row = ban({
    email,
    eventId: null,
    reason: reason ?? 'banned from live monitoring',
    bannedBy: event.context.auth ? `user#${event.context.auth.userId}` : null,
  })

  let disconnected: boolean
  // Remote sessions key off the stream name (their SRS client id is the node's
  // relay, unknown to this backend); local sessions off the SRS client id.
  const session =
    PublishSessionsRepository.findActiveByStream(email) ??
    PublishSessionsRepository.findActiveByClientId(clientId)
  const io = getSocketIO()
  if (session?.nodeId) {
    // Remote media-node session — tell the node to end it over the socket
    disconnected =
      io !== null &&
      emitToNode(io, session.nodeId, 'node:kick', {
        streamName: session.streamName,
        reason: reason ?? 'banned',
      })
  } else {
    // Local session — kill the SRS client directly
    disconnected = await killClient(clientId)
  }

  audit(
    disconnected ? 'warn' : 'error',
    'publish',
    `admin banned+disconnected ${email} (${disconnected ? 'ok' : 'disconnect failed'})`,
    {
      actor: email,
      streamName: email,
      detail: { email, clientId, banId: row.id },
    },
  )
  if (!disconnected) {
    // ban stands even if the disconnect raced (stream already gone)
    return { ok: true, banned: true, disconnected: false, ban: row }
  }
  return { ok: true, banned: true, disconnected: true, ban: row }
})
