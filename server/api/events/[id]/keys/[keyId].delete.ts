/** Revoke a stream key (publisher can no longer publish; student needs re-issue). */
import { revokeKey } from '../../../../services/stream-keys'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const keyId = Number(getRouterParam(event, 'keyId'))
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(keyId) || keyId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }
  revokeKey(id, keyId)
  setResponseStatus(event, 204)
  return null
})
