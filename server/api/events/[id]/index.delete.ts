/** Delete an event (the default event is protected). */
import { deleteEvent } from '../../../services/events'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  deleteEvent(id)
  setResponseStatus(event, 204)
  return null
})
