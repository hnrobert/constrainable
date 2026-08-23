/**
 * stream_keys table — data access only. A key ties a stream name to a secret
 * token (argon2id hash). The on_publish hot path resolves by streamName, so
 * `stream_name` is indexed (see schema). Joins for the key list live here.
 */
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../database/db'
import { streamKeys, eventEnrollments, students, type StreamKey, type NewStreamKey } from '../database/schema'

export const StreamKeysRepository = {
  /** on_publish hot path: all keys for a stream name (a reissue rotates in place). */
  findAllByStreamName(streamName: string): StreamKey[] {
    return db.select().from(streamKeys).where(eq(streamKeys.streamName, streamName)).orderBy(asc(streamKeys.id)).all()
  },
  findByEventAndName(eventId: number, streamName: string): StreamKey | undefined {
    return db
      .select()
      .from(streamKeys)
      .where(and(eq(streamKeys.eventId, eventId), eq(streamKeys.streamName, streamName)))
      .get()
  },
  findByEventAndId(eventId: number, id: number): StreamKey | undefined {
    return db
      .select()
      .from(streamKeys)
      .where(and(eq(streamKeys.id, id), eq(streamKeys.eventId, eventId)))
      .get()
  },
  /** Enrollment ids in an event that still have a non-revoked key. */
  findActiveEnrollmentIdsByEvent(eventId: number): number[] {
    return db
      .select({ enrollmentId: streamKeys.enrollmentId })
      .from(streamKeys)
      .where(and(eq(streamKeys.eventId, eventId), eq(streamKeys.revoked, false)))
      .all()
      .map((r) => r.enrollmentId)
      .filter((x): x is number => x != null)
  },
  /** Key list: keys joined to enrollment + student for display. */
  listWithStudentByEvent(eventId: number) {
    return db
      .select({
        key: streamKeys,
        studentNumber: students.studentNumber,
        studentLabel: students.name,
        seatLabel: eventEnrollments.seatLabel,
      })
      .from(streamKeys)
      .leftJoin(eventEnrollments, eq(eventEnrollments.id, streamKeys.enrollmentId))
      .leftJoin(students, eq(students.id, eventEnrollments.studentId))
      .where(eq(streamKeys.eventId, eventId))
      .orderBy(asc(streamKeys.streamName))
      .all()
  },
  /** Record last use on a successful publish. */
  touch(id: number): void {
    db.update(streamKeys).set({ lastUsedAt: new Date() }).where(eq(streamKeys.id, id)).run()
  },
  revoke(id: number): void {
    db.update(streamKeys).set({ revoked: true }).where(eq(streamKeys.id, id)).run()
  },
  /** Revoke every active key tied to an enrollment (roster removal). */
  revokeActiveByEnrollment(enrollmentId: number): void {
    db.update(streamKeys)
      .set({ revoked: true })
      .where(and(eq(streamKeys.enrollmentId, enrollmentId), eq(streamKeys.revoked, false)))
      .run()
  },
  /** Re-issue: rotate the token in place and clear any revoke. */
  rotate(id: number, patch: { tokenHash: string; tokenPreview: string; enrollmentId: number }): void {
    db.update(streamKeys)
      .set({
        tokenHash: patch.tokenHash,
        tokenPreview: patch.tokenPreview,
        revoked: false,
        lastUsedAt: null,
        enrollmentId: patch.enrollmentId,
      })
      .where(eq(streamKeys.id, id))
      .run()
  },
  insert(values: NewStreamKey): StreamKey {
    return db.insert(streamKeys).values(values).returning().get()
  },
}
