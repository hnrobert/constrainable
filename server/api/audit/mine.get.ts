/**
 * The caller's OWN audit trail: entries where their account email is the
 * actor OR the streamName — their actions (logins, node picks) AND everything
 * about their publishing (rejects, violations, bans, forced disconnects), so a
 * regular user can see exactly WHY a stream failed. Any logged-in session; the
 * all-events admin view stays at GET /api/audit. Query params:
 * ?level=&category=&q=&limit=.
 */
import { createError } from 'h3'
import { UsersRepository } from '../../repositories/users.repository'
import { listAudit } from '../../services/audit'
import { AUDIT_CATEGORIES, AUDIT_LEVELS } from '#shared/audit'

/** Coerce a raw query value into one of the allowed enum values, else null. */
function pick<T extends string>(v: string | null | undefined, allowed: readonly T[]): T | null {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

export default defineEventHandler((event) => {
  const auth = event.context.auth
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  const user = UsersRepository.findById(auth.userId)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'account not found' })

  const q = getQuery(event)
  return listAudit({
    involvedEmail: user.email,
    level: pick(q.level ? String(q.level) : null, AUDIT_LEVELS),
    category: pick(q.category ? String(q.category) : null, AUDIT_CATEGORIES),
    q: q.q ? String(q.q) : null,
    limit: q.limit ? Number(q.limit) : null,
  })
})
