/**
 * event_slug_aliases table — data access only. Written by the events service
 * when an event key changes; read by the guide endpoint to redirect old keys.
 */
import { eq } from 'drizzle-orm'
import { db } from '../database/db'
import { eventSlugAliases, type EventSlugAlias } from '../database/schema'

export const EventSlugAliasesRepository = {
  findByOldSlug(oldSlug: string): EventSlugAlias | undefined {
    return db.select().from(eventSlugAliases).where(eq(eventSlugAliases.oldSlug, oldSlug)).get()
  },
  /** Upsert: a renamed-away key now points at its event. */
  set(oldSlug: string, eventId: number): void {
    db.insert(eventSlugAliases)
      .values({ oldSlug, eventId })
      .onConflictDoUpdate({ target: eventSlugAliases.oldSlug, set: { eventId } })
      .run()
  },
  /** Drop the alias when a new event claims the retired key for itself. */
  remove(oldSlug: string): void {
    db.delete(eventSlugAliases).where(eq(eventSlugAliases.oldSlug, oldSlug)).run()
  },
  /** Drop all aliases pointing at an event (used on delete). */
  removeByEvent(eventId: number): void {
    db.delete(eventSlugAliases).where(eq(eventSlugAliases.eventId, eventId)).run()
  },
}
