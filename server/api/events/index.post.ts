/** Create an event. */
import { createEvent } from '../../services/events'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event)
  return createEvent(body ?? {})
})
