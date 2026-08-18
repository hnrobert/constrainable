/**
 * List audit log entries, newest-first, with optional filters. Admin-only
 * (requireAdmin). Query params: ?level=&category=&eventId=&q=&limit=.
 */
import { listAudit } from '../../services/audit'
import { AUDIT_CATEGORIES, AUDIT_LEVELS } from '#shared/audit'
import type { AuditCategory, AuditLevel } from '#shared/events'

/** Coerce a raw query value into one of the allowed enum values, else null. */
function pick<T extends string>(v: string | null | undefined, allowed: readonly T[]): T | null {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

export default defineEventHandler((event) => {
  requireAdmin(event)
  const q = getQuery(event)
  return listAudit({
    level: pick(q.level ? String(q.level) : null, AUDIT_LEVELS),
    category: pick(q.category ? String(q.category) : null, AUDIT_CATEGORIES),
    eventId: q.eventId ? Number(q.eventId) : null,
    q: q.q ? String(q.q) : null,
    limit: q.limit ? Number(q.limit) : null,
  })
})
