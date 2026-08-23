/**
 * audit_log table — data access only. Append-only writes; the service layer emits
 * the realtime `audit:created` event on top of the insert. Reads use server-side
 * filtering + paging (the log can grow large), ordered newest-first.
 */
import { and, desc, eq, like, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../database/db'
import { auditLog, type AuditEntry, type NewAuditEntry } from '../database/schema'

/** Filter shape shared by the row read and the count. */
type AuditRowFilters = {
  level?: AuditEntry['level'] | null
  category?: AuditEntry['category'] | null
  eventId?: number | null
  actor?: string | null
  involvedEmail?: string | null
  q?: string | null
}

/** WHERE conditions for the filters — one source for findMany + countFiltered. */
function conditionsOf(f: AuditRowFilters): SQL[] {
  const conds: SQL[] = []
  if (f.level) conds.push(eq(auditLog.level, f.level))
  if (f.category) conds.push(eq(auditLog.category, f.category))
  if (f.eventId) conds.push(eq(auditLog.eventId, f.eventId))
  if (f.actor) conds.push(eq(auditLog.actor, f.actor))
  if (f.involvedEmail) {
    const involved = or(eq(auditLog.actor, f.involvedEmail), eq(auditLog.streamName, f.involvedEmail))
    if (involved) conds.push(involved)
  }
  if (f.q) {
    const p = `%${f.q}%`
    const textCond = or(like(auditLog.message, p), like(auditLog.streamName, p))
    if (textCond) conds.push(textCond)
  }
  return conds
}

export const AuditLogRepository = {
  insert(values: NewAuditEntry): AuditEntry {
    return db.insert(auditLog).values(values).returning().get()
  },

  /**
   * Newest-first filtered read, one page. `limit` + `offset` are required —
   * the service clamps the page size to a sane max so a huge log never loads
   * wholesale into memory.
   */
  findMany(filters: AuditRowFilters & { limit: number; offset: number }): AuditEntry[] {
    const conds = conditionsOf(filters)
    return db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.ts), desc(auditLog.id))
      .limit(filters.limit)
      .offset(filters.offset)
      .all()
  },

  /** Total rows matching the SAME filters — drives page counts. */
  countFiltered(filters: AuditRowFilters): number {
    const conds = conditionsOf(filters)
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .get()
    return Number(row?.n ?? 0)
  },
}
