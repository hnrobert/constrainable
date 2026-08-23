/**
 * Clear (unset) the shared per-event publish key. Publishes using this key are
 * rejected afterwards. Admin-only.
 */
import { createError } from 'h3'
import { clearPublishKey } from '../../../services/events'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  clearPublishKey(id)
  return { ok: true }
})
