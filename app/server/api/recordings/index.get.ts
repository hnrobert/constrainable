/** List recordings with optional filters: ?eventId=&date=YYYY-MM-DD&q=. */
import { listRecordings } from '../../services/recordings'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const q = getQuery(event)
  return listRecordings({
    eventId: q.eventId ? Number(q.eventId) : null,
    date: q.date ? String(q.date) : null,
    q: q.q ? String(q.q) : null,
  })
})
