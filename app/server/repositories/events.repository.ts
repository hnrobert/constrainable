/**
 * events table — data access only. An event scopes its roster/keys/sessions/
 * recordings. No isDefault concept (no seed); ordering is by scheduled start.
 */
import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '../database/db'
import { events, type Event, type NewEvent } from '../database/schema'

export const EventsRepository = {
  findAll(): Event[] {
    return db.select().from(events).orderBy(asc(events.startsAt), asc(events.id)).all()
  },
  findById(id: number): Event | undefined {
    return db.select().from(events).where(eq(events.id, id)).get()
  },
  /** Used for slug-uniqueness checks; pass exceptId to exclude the row itself. */
  findBySlugExcept(slug: string, exceptId?: number): Event | undefined {
    const q = exceptId
      ? db
          .select()
          .from(events)
          .where(and(eq(events.slug, slug), ne(events.id, exceptId)))
      : db.select().from(events).where(eq(events.slug, slug))
    return q.get()
  },
  /** Public participant guide resolves an event by its slug. */
  findBySlug(slug: string): Event | undefined {
    return db.select().from(events).where(eq(events.slug, slug)).get()
  },
  /** on_publish hot path: candidate events whose publish-token prefix matches. */
  findByPublishTokenPrefix(prefix: string): Event[] {
    return db.select().from(events).where(eq(events.publishTokenPrefix, prefix)).all()
  },
  /** on_publish hot path: the single event whose shared publish key matches. */
  findByPublishKey(key: string): Event | undefined {
    return db.select().from(events).where(eq(events.publishKey, key)).get()
  },
  insert(values: NewEvent): Event {
    return db.insert(events).values(values).returning().get()
  },
  update(id: number, set: Record<string, unknown>): void {
    db.update(events).set(set).where(eq(events.id, id)).run()
  },
  remove(id: number): void {
    db.delete(events).where(eq(events.id, id)).run()
  },
}
