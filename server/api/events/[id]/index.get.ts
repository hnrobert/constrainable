/**
 * Get one event. Authorization is enforced here (not just in the middleware):
 * a logged-in regular user may only fetch events they can view (public,
 * registered, or one of their groups). Admins see any. Outsiders cannot reach
 * this endpoint (it is not allowlisted) — they use /api/events/public.
 */
import { createError } from 'h3'
import { getEvent } from '../../../services/events'
import { canViewEvent } from '../../../services/groups'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  const ev = getEvent(id)
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'event not found' })
  const auth = event.context.auth
  // draft/scheduled are admin-only until live — 404 (no existence leak)
  if (auth?.role !== 'admin' && (ev.status === 'draft' || ev.status === 'scheduled')) {
    throw createError({ statusCode: 404, statusMessage: 'event not found' })
  }
  if (!canViewEvent(auth, { visibility: ev.visibility, groupIds: ev.groups.map((g) => g.id) })) {
    throw createError({ statusCode: 403, statusMessage: 'forbidden' })
  }
  return ev
})
