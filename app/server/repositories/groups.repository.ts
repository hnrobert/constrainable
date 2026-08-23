/**
 * groups / user_groups / event_groups — data access only. Group CRUD plus the
 * membership & event-scoping joins that back authorization (visibility =
 * 'groups'). Pure Drizzle queries, no business logic, no HTTP errors.
 */
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { db } from '../database/db'
import {
  eventGroups,
  groups,
  userGroups,
  type Group,
  type NewGroup,
} from '../database/schema'

export const GroupsRepository = {
  findAll(): Group[] {
    return db.select().from(groups).orderBy(asc(groups.name), asc(groups.id)).all()
  },
  findById(id: number): Group | undefined {
    return db.select().from(groups).where(eq(groups.id, id)).get()
  },
  findByName(name: string): Group | undefined {
    return db.select().from(groups).where(eq(groups.name, name)).get()
  },
  insert(values: NewGroup): Group {
    return db.insert(groups).values(values).returning().get()
  },
  update(id: number, set: Record<string, unknown>): void {
    db.update(groups).set(set).where(eq(groups.id, id)).run()
  },
  remove(id: number): void {
    db.delete(groups).where(eq(groups.id, id)).run()
  },

  /* ------------------------------ membership ------------------------------ */

  /** Groups a user belongs to. */
  findGroupsForUser(userId: number): Group[] {
    return db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        createdAt: groups.createdAt,
      })
      .from(userGroups)
      .innerJoin(groups, eq(groups.id, userGroups.groupId))
      .where(eq(userGroups.userId, userId))
      .orderBy(asc(groups.name))
      .all()
  },
  /** Just the group ids for a user (authorization hot path). */
  findUserGroupIds(userId: number): number[] {
    return db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId))
      .all()
      .map((r) => r.groupId)
  },
  countMembers(groupId: number): number {
    const row = db.select({ n: count() }).from(userGroups).where(eq(userGroups.groupId, groupId)).get()
    return row?.n ?? 0
  },
  addUserToGroup(userId: number, groupId: number): void {
    db.insert(userGroups).values({ userId, groupId }).onConflictDoNothing().run()
  },
  removeUserFromGroup(userId: number, groupId: number): void {
    db.delete(userGroups).where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId))).run()
  },
  /** Replace a user's entire group membership with `groupIds`. */
  setUserGroups(userId: number, groupIds: number[]): void {
    db.delete(userGroups).where(eq(userGroups.userId, userId)).run()
    if (groupIds.length) {
      db.insert(userGroups).values(groupIds.map((groupId) => ({ userId, groupId }))).run()
    }
  },
  /** True if the user belongs to at least one of the given groups. */
  userInAnyGroup(userId: number, groupIds: number[]): boolean {
    if (groupIds.length === 0) return false
    const rows = db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(and(eq(userGroups.userId, userId), inArray(userGroups.groupId, groupIds)))
      .all()
    return rows.length > 0
  },

  /* ----------------------------- event scoping ---------------------------- */

  /** Groups linked to an event (for display + the 'groups' visibility check). */
  findGroupsForEvent(eventId: number): Group[] {
    return db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        createdAt: groups.createdAt,
      })
      .from(eventGroups)
      .innerJoin(groups, eq(groups.id, eventGroups.groupId))
      .where(eq(eventGroups.eventId, eventId))
      .orderBy(asc(groups.name))
      .all()
  },
  findEventGroupIds(eventId: number): number[] {
    return db
      .select({ groupId: eventGroups.groupId })
      .from(eventGroups)
      .where(eq(eventGroups.eventId, eventId))
      .all()
      .map((r) => r.groupId)
  },
  /** Replace the set of groups an event is scoped to. */
  setEventGroups(eventId: number, groupIds: number[]): void {
    db.delete(eventGroups).where(eq(eventGroups.eventId, eventId)).run()
    if (groupIds.length) {
      db.insert(eventGroups).values(groupIds.map((groupId) => ({ eventId, groupId }))).run()
    }
  },
}
