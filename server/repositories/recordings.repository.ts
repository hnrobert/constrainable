/**
 * recordings table — data access only. Archived MP4 (or FLV fallback) metadata.
 * `filePath` is relative to RECORD_DIR; file I/O itself lives in the service.
 */
import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '../database/db'
import { recordings, type Recording, type NewRecording } from '../database/schema'

export const RecordingsRepository = {
  findAll(): Recording[] {
    return db.select().from(recordings).orderBy(desc(recordings.startedAt)).all()
  },
  findByEvent(eventId: number): Recording[] {
    return db
      .select()
      .from(recordings)
      .where(eq(recordings.eventId, eventId))
      .orderBy(desc(recordings.startedAt))
      .all()
  },
  /**
   * Merge target: the most recent recording row for the same event + stream
   * name. A user re-publishing into the same event appends to it.
   */
  findMergeTarget(eventId: number, streamName: string): Recording | undefined {
    return db
      .select()
      .from(recordings)
      .where(and(eq(recordings.eventId, eventId), eq(recordings.streamName, streamName)))
      .orderBy(desc(recordings.startedAt))
      .get()
  },
  update(id: number, set: Partial<NewRecording>): void {
    db.update(recordings).set(set).where(eq(recordings.id, id)).run()
  },
  findById(id: number): Recording | undefined {
    return db.select().from(recordings).where(eq(recordings.id, id)).get()
  },
  /** Retention sweep: recordings started before the cutoff date. */
  findExpired(cutoff: Date): Recording[] {
    return db.select().from(recordings).where(lt(recordings.startedAt, cutoff)).all()
  },
  insert(values: NewRecording): Recording {
    return db.insert(recordings).values(values).returning().get()
  },
  remove(id: number): void {
    db.delete(recordings).where(eq(recordings.id, id)).run()
  },
}
