/** Delete a group (admin-only). Cascades to user_groups + event_groups. */
import { createError } from 'h3'
import { deleteGroup } from '../../../services/groups'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid group id' })
  }
  deleteGroup(id)
  setResponseStatus(event, 204)
  return null
})
