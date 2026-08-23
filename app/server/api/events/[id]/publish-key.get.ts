/**
 * Reveal the current shared publish key (retrievable by design — unlike the
 * hashed publish token). Used by the admin detail page to display/copy an
 * already-set key. Admin-only.
 */
import { createError } from 'h3'
import { getPublishKey } from '../../../services/events'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  return { key: getPublishKey(id) }
})
