/**
 * Active + recent publish sessions for the realtime panel. The live updates
 * arrive over Socket.IO; this endpoint gives the initial table contents (any
 * session not yet ended). Optional ?eventId= filter.
 */
import { listActiveSessions } from '../../services/streams'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const q = getQuery(event)
  const eventId = q.eventId ? Number(q.eventId) : null
  return listActiveSessions(Number.isInteger(eventId) ? eventId : null)
})
