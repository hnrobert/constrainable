/**
 * node_settings table — data access only. Per-node AUTO-assignment quota
 * (`maxUsers`); absent row = DEFAULT_MAX_USERS. Manual admin assignment
 * bypasses the cap (it's an allocator guide, not a hard wall).
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '../database/db'
import { nodeSettings, users, type NodeSetting } from '../database/schema'

export const DEFAULT_MAX_USERS = 50

export const NodeSettingsRepository = {
  /** Effective cap for a node (absent row → default). */
  getMaxUsers(nodeId: string): number {
    const row = db.select().from(nodeSettings).where(eq(nodeSettings.nodeId, nodeId)).get()
    return row?.maxUsers ?? DEFAULT_MAX_USERS
  },
  upsert(nodeId: string, maxUsers: number): NodeSetting {
    return db
      .insert(nodeSettings)
      .values({ nodeId, maxUsers })
      .onConflictDoUpdate({ target: nodeSettings.nodeId, set: { maxUsers } })
      .returning()
      .get()
  },
  /** nodeId → assigned user count (the allocator's load signal). */
  assignedCount(nodeId: string): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.nodeId, nodeId))
      .get()
    return row?.n ?? 0
  },
}
