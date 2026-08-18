/** List an event's roster (enrolled students + whether each has an active key). */
import { listRoster } from '../../../../services/roster'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  return listRoster(id)
})
