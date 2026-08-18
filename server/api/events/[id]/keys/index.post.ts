/**
 * Generate (or re-issue) a stream key for a student in an event. Creates the
 * student + enrollment on the fly if absent. Returns the plaintext token ONCE.
 */
import { generateKeyForEvent } from '../../../../services/stream-keys'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  const body = await readBody(event)
  const studentNumber = String(body?.studentNumber ?? '').trim()
  const name = String(body?.name ?? '').trim()
  if (!studentNumber || !name) {
    throw createError({ statusCode: 400, statusMessage: 'studentNumber and name are required' })
  }
  return generateKeyForEvent(id, {
    studentNumber,
    name,
    email: body?.email ? String(body.email) : null,
    seatLabel: body?.seatLabel ? String(body.seatLabel) : null,
    streamName: body?.streamName ? String(body.streamName) : null,
  })
})
