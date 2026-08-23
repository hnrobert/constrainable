/**
 * stream_bans table — data access only. Site-wide bans have eventId NULL;
 * event bans are scoped. Unique on (email, eventId) — note SQLite treats NULLs
 * as distinct, so site-wide uniqueness is enforced in the service layer.
 */
import { desc, eq, isNull, and, or, inArray } from 'drizzle-orm'
import { db } from '../database/db'
import { streamBans, type StreamBan, type NewStreamBan } from '../database/schema'

export const StreamBansRepository = {
  listAll(): StreamBan[] {
    return db.select().from(streamBans).orderBy(desc(streamBans.createdAt)).all()
  },
  listByEvent(eventId: number): StreamBan[] {
    return db
      .select()
      .from(streamBans)
      .where(eq(streamBans.eventId, eventId))
      .orderBy(desc(streamBans.createdAt))
      .all()
  },
  /** Site-wide bans (eventId NULL). */
  listSiteWide(): StreamBan[] {
    return db.select().from(streamBans).where(isNull(streamBans.eventId)).all()
  },
  /** Site-wide ban for an email? (gateway stage-2 check) */
  findSiteWide(email: string): StreamBan | undefined {
    return db
      .select()
      .from(streamBans)
      .where(and(eq(streamBans.email, email), isNull(streamBans.eventId)))
      .get()
  },
  /** All bans covering (email, event) — site-wide OR this specific event. */
  listBlocking(email: string, eventId: number | null | undefined): StreamBan[] {
    const conds = [and(eq(streamBans.email, email), isNull(streamBans.eventId))]
    if (eventId != null) {
      conds.push(and(eq(streamBans.email, email), eq(streamBans.eventId, eventId)))
    }
    return db.select().from(streamBans).where(or(...conds)).all()
  },
  /** Ban covering (email, event) — site-wide OR this specific event. (gateway publish check) */
  findBlocking(email: string, eventId: number | null | undefined): StreamBan | undefined {
    return this.listBlocking(email, eventId)[0]
  },
  /**
   * Delete every auto strict-limits ban (all emails, all scopes). One-shot
   * boot cleanup: that enforcement path no longer writes bans — spec
   * violations are rejected per-publish at the node — so rows written by
   * older builds are stale data, not state. Returns the removed count.
   */
  purgeStrictLimits(): number {
    const stale = db
      .select({ id: streamBans.id })
      .from(streamBans)
      .where(eq(streamBans.bannedBy, 'system:strict-limits'))
      .all()
    if (stale.length > 0) {
      db.delete(streamBans).where(inArray(streamBans.id, stale.map((r) => r.id))).run()
    }
    return stale.length
  },
  insert(values: NewStreamBan): StreamBan {
    return db.insert(streamBans).values(values).returning().get()
  },
  remove(id: number): void {
    db.delete(streamBans).where(eq(streamBans.id, id)).run()
  },
}
