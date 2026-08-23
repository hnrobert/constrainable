/**
 * students table — data access only. Students are global (reused across
 * events); resolved by student number (student ID).
 */
import { eq } from 'drizzle-orm'
import { db } from '../database/db'
import { students, type Student, type NewStudent } from '../database/schema'

export const StudentsRepository = {
  findById(id: number): Student | undefined {
    return db.select().from(students).where(eq(students.id, id)).get()
  },
  findByStudentNumber(studentNumber: string): Student | undefined {
    return db.select().from(students).where(eq(students.studentNumber, studentNumber)).get()
  },
  insert(values: NewStudent): Student {
    return db.insert(students).values(values).returning().get()
  },
  updateProfile(id: number, name: string, email: string | null): void {
    db.update(students).set({ name, email }).where(eq(students.id, id)).run()
  },
}
