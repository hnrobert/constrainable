/**
 * audit_log table — data access only. Append-only writes; the service layer emits
 * the realtime `audit:created` event on top of the insert. Reads use server-side
 * filtering + a required LIMIT (the log can grow large), ordered newest-first.
 */
import { and, desc, eq, like, or, type SQL } from 'drizzle-orm'
import { db } from '../database/db'
import { auditLog, type AuditEntry, type NewAuditEntry } from '../database/schema'

export const AuditLogRepository = {
  insert(values: NewAuditEntry): AuditEntry {
    return db.insert(auditLog).values(values).returning().get()
  },

  /**
   * Newest-first filtered read. All filters optional; `q` is a case-insensitive
   * LIKE over message + stream name. `limit` is required — the service clamps it
   * to a sane max so a huge log never loads wholesale into memory.
   */
  findMany(filters: {
    level?: AuditEntry['level'] | null
    category?: AuditEntry['category'] | null
    eventId?: number | null
    actor?: string | null
    involvedEmail?: string | null
    q?: string | null
    limit: number
  }): AuditEntry[] {
    const conds: SQL[] = []
    if (filters.level) conds.push(eq(auditLog.level, filters.level))
    if (filters.category) conds.push(eq(auditLog.category, filters.category))
    if (filters.eventId) conds.push(eq(auditLog.eventId, filters.eventId))
    if (filters.actor) conds.push(eq(auditLog.actor, filters.actor))
    if (filters.involvedEmail) {
      const involved = or(eq(auditLog.actor, filters.involvedEmail), eq(auditLog.streamName, filters.involvedEmail))
      if (involved) conds.push(involved)
    }
    if (filters.q) {
      const p = `%${filters.q}%`
      const textCond = or(like(auditLog.message, p), like(auditLog.streamName, p))
      if (textCond) conds.push(textCond)
    }
    return db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.ts), desc(auditLog.id))
      .limit(filters.limit)
      .all()
  },
}
