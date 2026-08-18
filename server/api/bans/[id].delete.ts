/** Lift a streaming ban by id. */
import { unban } from '../../services/stream-bans'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }
  unban(id, event.context.auth ? `user#${event.context.auth.userId}` : null)
  return { ok: true }
})
