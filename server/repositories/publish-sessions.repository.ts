/**
 * publish_sessions table — data access only. One row per publish attempt
 * (allowed/rejected → … → killed/ended). Drives the realtime panel and the
 * viewer catalog's live-stream list.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../database/db'
import {
  publishSessions,
  type PublishSession,
  type NewPublishSession,
} from '../database/schema'

export const PublishSessionsRepository = {
  findById(id: number): PublishSession | undefined {
    return db.select().from(publishSessions).where(eq(publishSessions.id, id)).get()
  },
  /** Newest not-yet-ended session for one stream — playback/kick routing. */
  /** active (not ended) sessions of one event — event-end cutoff */
  findActiveByEvent(eventId: number): PublishSession[] {
    return db
      .select()
      .from(publishSessions)
      .where(and(eq(publishSessions.eventId, eventId), isNull(publishSessions.endedAt)))
      .all()
  },

  findActiveByStream(streamName: string): PublishSession | undefined {
    return db
      .select()
      .from(publishSessions)
      .where(and(eq(publishSessions.streamName, streamName), isNull(publishSessions.endedAt)))
      .orderBy(desc(publishSessions.startedAt))
      .limit(1)
      .get()
  },
  /** Newest not-yet-ended session by SRS client id — dashboard kick routing. */
  findActiveByClientId(clientId: string): PublishSession | undefined {
    return db
      .select()
      .from(publishSessions)
      .where(and(eq(publishSessions.srsClientId, clientId), isNull(publishSessions.endedAt)))
      .orderBy(desc(publishSessions.startedAt))
      .limit(1)
      .get()
  },
  /** Realtime panel: sessions not yet ended, newest first; optional event filter. */
  findActive(eventId?: number | null): PublishSession[] {
    const conds = [isNull(publishSessions.endedAt)]
    if (eventId && eventId > 0) conds.push(eq(publishSessions.eventId, eventId))
    return db
      .select()
      .from(publishSessions)
      .where(and(...conds))
      .orderBy(desc(publishSessions.startedAt))
      .all()
  },
  /** All sessions for one event (any status), newest first — the Insights tab. */
  findAllByEvent(eventId: number): PublishSession[] {
    return db
      .select()
      .from(publishSessions)
      .where(eq(publishSessions.eventId, eventId))
      .orderBy(desc(publishSessions.startedAt))
      .all()
  },
  /** Viewer catalog: live sessions in a playing state, with current dimensions. */
  findLiveForCatalog() {
    return db
      .select({
        eventId: publishSessions.eventId,
        streamName: publishSessions.streamName,
        width: publishSessions.width,
        height: publishSessions.height,
      })
      .from(publishSessions)
      .where(
        and(
          isNull(publishSessions.endedAt),
          inArray(publishSessions.status, ['allowed', 'compliant', 'violating']),
        ),
      )
      .all()
  },
  insert(values: NewPublishSession): PublishSession {
    return db.insert(publishSessions).values(values).returning().get()
  },
  updateMetrics(
    id: number,
    m: {
      width: number | null
      height: number | null
      fps: number | null
      bitrateKbps: number | null
      audioKbps: number | null
    },
  ): void {
    db.update(publishSessions)
      .set({
        width: m.width,
        height: m.height,
        fps: m.fps,
        bitrateKbps: m.bitrateKbps,
        audioKbps: m.audioKbps,
        lastMetricAt: new Date(),
      })
      .where(eq(publishSessions.id, id))
      .run()
  },
  updateStatus(
    id: number,
    status: PublishSession['status'],
    extra: { endedAt?: Date; compliant?: boolean } = {},
  ): void {
    const patch: Record<string, unknown> = { status }
    if (extra.endedAt !== undefined) patch.endedAt = extra.endedAt
    if (extra.compliant !== undefined) patch.compliant = extra.compliant ? 1 : 0
    db.update(publishSessions).set(patch).where(eq(publishSessions.id, id)).run()
  },
  markEnded(id: number, status: PublishSession['status'], endedAt: Date): void {
    db.update(publishSessions)
      .set({ endedAt, status })
      .where(eq(publishSessions.id, id))
      .run()
  },
}
