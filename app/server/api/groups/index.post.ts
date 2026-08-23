/** Create a group (admin-only). Body: { name, description? }. */
import { createError } from 'h3'
import { createGroup } from '../../services/groups'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event)
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  const description = body?.description != null ? String(body.description) : null
  return createGroup({ name, description })
})
