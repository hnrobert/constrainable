/** Delete an invite link (admin-only). */
import { createError } from 'h3'
import { removeInvite } from '../../services/invites'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid invite id' })
  }
  removeInvite(id)
  setResponseStatus(event, 204)
  return null
})
