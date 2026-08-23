/** List stream keys for an event (token preview only, never the full token). */
import { listKeys } from '../../../../services/stream-keys'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  return listKeys(id)
})
