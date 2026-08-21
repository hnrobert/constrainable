/**
 * List events, authorization-filtered. Admin sees all; a regular user sees only
 * events they may view (canViewEvent: public, registered, or their groups).
 * Outsiders use /api/events/public instead — this endpoint requires a session.
 */
import { listEvents, listEventsForUser } from '../../services/events'
import { canViewEvent } from '../../services/groups'

export default defineEventHandler((event) => {
  const auth = event.context.auth
  // draft/scheduled are admin-only until they go live
  const all = auth?.role === 'admin' ? listEvents() : listEventsForUser()
  return all.filter((e) =>
    canViewEvent(auth, { visibility: e.visibility, groupIds: e.groups.map((g) => g.id) }),
  )
})
