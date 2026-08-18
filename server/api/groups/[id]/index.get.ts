/** Get one group (admin-only). */
import { createError } from 'h3'
import { getGroup } from '../../../services/groups'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid group id' })
  }
  return getGroup(id)
})
