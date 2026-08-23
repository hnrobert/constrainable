/**
 * List streaming bans. ?eventId= filters to one event's scope (the blacklist
 * tab also shows site-wide rows for context); no filter = all bans.
 */
import { listBans } from '../../services/stream-bans'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const q = getQuery(event)
  const eventId = q.eventId ? Number(q.eventId) : null
  return listBans(Number.isInteger(eventId) && eventId ? eventId : undefined)
})
