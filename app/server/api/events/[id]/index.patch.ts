/** Update an event. */
import { updateEvent } from '../../../services/events'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  const body = await readBody(event)
  return await updateEvent(id, body ?? {})
})
