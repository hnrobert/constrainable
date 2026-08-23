/** Update a group's name/description (admin-only). */
import { createError } from 'h3'
import { updateGroup } from '../../../services/groups'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid group id' })
  }
  const body = await readBody(event)
  const patch: { name?: string; description?: string | null } = {}
  if (body?.name != null) patch.name = String(body.name)
  if (body?.description !== undefined) patch.description = body.description != null ? String(body.description) : null
  return updateGroup(id, patch)
})
