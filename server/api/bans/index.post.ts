/**
 * Add a streaming ban. body: { email, eventId?: number|null (null=site-wide),
 * reason? }. The gateway enforces it on the publisher's next connect/publish.
 */
import { ban } from '../../services/stream-bans'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody<{ email?: string; eventId?: number | null; reason?: string }>(event)
  const email = String(body?.email ?? '').trim()
  if (!email) throw createError({ statusCode: 400, statusMessage: 'email is required' })
  return ban({
    email,
    eventId: body?.eventId ?? null,
    reason: body?.reason ?? null,
    bannedBy: event.context.auth ? `user#${event.context.auth.userId}` : null,
  })
})
