/**
 * Set the shared per-event publish key (random, or custom when `body.key` is
 * supplied). Returns the plaintext key. Admin-only. Unlike the publish token,
 * this key is stored verbatim so it can be redisplayed on the participant guide.
 */
import { createError } from 'h3'
import { setPublishKey } from '../../../services/events'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  const body = await readBody<{ key?: unknown }>(event)
  const custom = typeof body?.key === 'string' ? body.key : undefined
  return setPublishKey(id, custom)
})
