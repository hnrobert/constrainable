/**
 * Admin: ban a live publisher (site-wide) and disconnect them immediately.
 * The ban is permanent — lifted only from the blacklist UI. Disconnect kills
 * the SRS client; SRS fires on_unpublish, ending the session and finalizing
 * the recording. With the RTMP gateway in front, the OBS connection tears
 * down too, and every reconnect is refused at the dance (salt) stage.
 */
import { createError, getRouterParam } from 'h3'
import { killClient } from '../../../services/srs-client'
import { ban } from '../../../services/stream-bans'
import { audit } from '../../../services/audit'

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
  const ok = await killClient(clientId)
  audit(ok ? 'warn' : 'error', 'publish', `admin banned+disconnected ${email} (${ok ? 'ok' : 'disconnect failed'})`, {
    detail: { email, clientId, banId: row.id },
  })
  if (!ok) {
    // ban stands even if the disconnect raced (stream already gone)
    return { ok: true, banned: true, disconnected: false, ban: row }
  }
  return { ok: true, banned: true, disconnected: true, ban: row }
})
