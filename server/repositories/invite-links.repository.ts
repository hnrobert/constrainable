/**
 * invite_links table — data access only. Single-use-ish group invite codes.
 * `consumeInvite()` in the invites service owns the validity + idempotency
 * rules; this layer just reads/writes rows.
 */
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../database/db'
import { inviteLinks, type InviteLink, type NewInviteLink } from '../database/schema'

export const InviteLinksRepository = {
  findByCode(code: string): InviteLink | undefined {
    return db.select().from(inviteLinks).where(eq(inviteLinks.code, code)).get()
  },
  /** All invites, newest first (admin management page). */
  findAll(): InviteLink[] {
    return db.select().from(inviteLinks).orderBy(desc(inviteLinks.createdAt), desc(inviteLinks.id)).all()
  },
  findByGroup(groupId: number): InviteLink[] {
    return db.select().from(inviteLinks).where(eq(inviteLinks.groupId, groupId)).all()
  },
  insert(values: NewInviteLink): InviteLink {
    return db.insert(inviteLinks).values(values).returning().get()
  },
  update(id: number, set: Record<string, unknown>): void {
    db.update(inviteLinks).set(set).where(eq(inviteLinks.id, id)).run()
  },
  remove(id: number): void {
    db.delete(inviteLinks).where(eq(inviteLinks.id, id)).run()
  },
  /** Atomically increment the use counter for a code. */
  incrementUsed(id: number): void {
    db.update(inviteLinks)
      .set({ usedCount: sql`${inviteLinks.usedCount} + 1` })
      .where(eq(inviteLinks.id, id))
      .run()
  },
}
