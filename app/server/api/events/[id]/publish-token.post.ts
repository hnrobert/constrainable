/**
 * Set or rotate the per-event publish token. With a `token` in the body it is
 * stored as the caller-chosen (custom) value (validated); without one a random
 * token is generated. Returns the plaintext ONCE (only the hash + prefix are
 * persisted). Admin-gated by the middleware.
 */
import { createError } from 'h3'
import { rotatePublishToken } from '../../../services/events'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  const body = await readBody<{ token?: unknown }>(event)
  const custom = typeof body?.token === 'string' ? body.token : undefined
  return rotatePublishToken(id, custom)
})
