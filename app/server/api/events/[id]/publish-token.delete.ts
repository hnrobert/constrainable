/** Clear (revoke) the per-event publish token. Admin-gated by the middleware. */
import { createError } from 'h3'
import { clearPublishToken } from '../../../services/events'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  clearPublishToken(id)
  return { ok: true }
})
