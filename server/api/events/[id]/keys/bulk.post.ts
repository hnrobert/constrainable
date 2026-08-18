/**
 * Generate stream keys for every enrolled student lacking an active one.
 * Returns plaintext tokens ONCE per generated key.
 */
import { generateKeysForUnkeyed } from '../../../../services/stream-keys'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  return generateKeysForUnkeyed(id)
})
