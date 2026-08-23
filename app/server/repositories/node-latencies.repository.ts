/**
 * node_latencies table — data access only. One row per (user, node): the
 * browser probes every node on each visit and upserts its measurement, so the
 * table is "latency at the user's most recent visit".
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../database/db'
import { nodeLatencies } from '../database/schema'

export const NodeLatenciesRepository = {
  /** Upsert one measurement (browser probes → POST /api/nodes/measure). */
  upsert(userId: number, nodeId: string, latencyMs: number): void {
    db.insert(nodeLatencies)
      .values({ userId, nodeId, latencyMs })
      .onConflictDoUpdate({
        target: [nodeLatencies.userId, nodeLatencies.nodeId],
        set: { latencyMs, measuredAt: new Date() },
      })
      .run()
  },
  /** Latest snapshot for one user: nodeId → ms (admin matrix row). */
  forUser(userId: number): { nodeId: string; latencyMs: number }[] {
    return db
      .select({ nodeId: nodeLatencies.nodeId, latencyMs: nodeLatencies.latencyMs })
      .from(nodeLatencies)
      .where(eq(nodeLatencies.userId, userId))
      .all()
  },
  /** All rows (admin matrix): userId → nodeId → ms. */
  matrix(): Map<number, Map<string, number>> {
    const rows = db
      .select({ userId: nodeLatencies.userId, nodeId: nodeLatencies.nodeId, latencyMs: nodeLatencies.latencyMs })
      .from(nodeLatencies)
      .all()
    const out = new Map<number, Map<string, number>>()
    for (const r of rows) {
      let m = out.get(r.userId)
      if (!m) out.set(r.userId, (m = new Map()))
      m.set(r.nodeId, r.latencyMs)
    }
    return out
  },
  /** One user's measured latency to one node (undefined = never measured). */
  get(userId: number, nodeId: string): number | undefined {
    const row = db
      .select({ latencyMs: nodeLatencies.latencyMs })
      .from(nodeLatencies)
      .where(and(eq(nodeLatencies.userId, userId), eq(nodeLatencies.nodeId, nodeId)))
      .get()
    return row?.latencyMs
  },
  /** Keep the table from outliving deleted nodes. */
  deleteNode(nodeId: string): void {
    db.delete(nodeLatencies).where(eq(nodeLatencies.nodeId, nodeId)).run()
  },
}
