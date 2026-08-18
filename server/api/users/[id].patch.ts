/**
 * Update a user's role and/or group membership (admin-only). Body is partial:
 *   { role?: 'admin'|'user', groupIds?: number[] }
 * `groupIds` replaces the user's membership wholesale when present.
 */
import { createError } from 'h3'
import { setUserGroups, setUserRole } from '../../services/groups'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid user id' })
  }
  const body = await readBody(event)

  if (body?.role != null) {
    const role = String(body.role)
    if (role !== 'admin' && role !== 'user') {
      throw createError({ statusCode: 400, statusMessage: 'role must be admin or user' })
    }
    setUserRole(id, role)
  }
  if (Array.isArray(body?.groupIds)) {
    const groupIds = body.groupIds
      .map((g: unknown) => Number(g))
      .filter((g: number) => Number.isInteger(g) && g > 0)
    setUserGroups(id, groupIds)
  }
  return { ok: true }
})
