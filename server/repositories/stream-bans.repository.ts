/**
 * stream_bans table — data access only. Site-wide bans have eventId NULL;
 * event bans are scoped. Unique on (email, eventId) — note SQLite treats NULLs
 * as distinct, so site-wide uniqueness is enforced in the service layer.
 */
import { desc, eq, isNull, and, or } from 'drizzle-orm'
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
  /** Ban covering (email, event) — site-wide OR this specific event. (gateway publish check) */
  findBlocking(email: string, eventId: number | null | undefined): StreamBan | undefined {
    const conds = [and(eq(streamBans.email, email), isNull(streamBans.eventId))]
    if (eventId != null) {
      conds.push(and(eq(streamBans.email, email), eq(streamBans.eventId, eventId)))
    }
    return db.select().from(streamBans).where(or(...conds)).get()
  },
  insert(values: NewStreamBan): StreamBan {
    return db.insert(streamBans).values(values).returning().get()
  },
  remove(id: number): void {
    db.delete(streamBans).where(eq(streamBans.id, id)).run()
  },
}
