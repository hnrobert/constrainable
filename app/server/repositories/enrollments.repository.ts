/**
 * event_enrollments table — data access only. An enrollment links a student to
 * an event (with a seat + status). Joins to students live here too since they
 * serve roster/key-list reads directly.
 */
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../database/db'
import { eventEnrollments, students, type Enrollment, type NewEnrollment } from '../database/schema'

export const EnrollmentsRepository = {
  findById(id: number): Enrollment | undefined {
    return db.select().from(eventEnrollments).where(eq(eventEnrollments.id, id)).get()
  },
  findByEventAndStudent(eventId: number, studentId: number): Enrollment | undefined {
    return db
      .select()
      .from(eventEnrollments)
      .where(
        and(eq(eventEnrollments.eventId, eventId), eq(eventEnrollments.studentId, studentId)),
      )
      .get()
  },
  /** Roster / unkeyed list: enrollments joined to their student, by student number. */
  listWithStudentByEvent(eventId: number) {
    return db
      .select({
        enrollment: eventEnrollments,
        studentNumber: students.studentNumber,
        name: students.name,
        email: students.email,
      })
      .from(eventEnrollments)
      .innerJoin(students, eq(students.id, eventEnrollments.studentId))
      .where(eq(eventEnrollments.eventId, eventId))
      .orderBy(asc(students.studentNumber))
      .all()
  },
  insert(values: NewEnrollment): Enrollment {
    return db.insert(eventEnrollments).values(values).returning().get()
  },
  updateSeat(id: number, seatLabel: string | null, status: Enrollment['status']): void {
    db.update(eventEnrollments)
      .set({ seatLabel, status })
      .where(eq(eventEnrollments.id, id))
      .run()
  },
  remove(id: number): void {
    db.delete(eventEnrollments).where(eq(eventEnrollments.id, id)).run()
  },
}
