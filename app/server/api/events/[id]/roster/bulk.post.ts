/**
 * Bulk-import a roster. Body: { students: [{ studentNumber, name, email?,
 * seatLabel? }] }. Accepts a bare array too. Upserts students + enrollments.
 */
import { importRoster } from '../../../../services/roster'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }
  const body = await readBody(event)
  const students = Array.isArray(body) ? body : body?.students
  if (!Array.isArray(students)) {
    throw createError({ statusCode: 400, statusMessage: 'students array required' })
  }
  return importRoster(
    id,
    students.map((s: any) => ({
      studentNumber: String(s?.studentNumber ?? ''),
      name: String(s?.name ?? ''),
      email: s?.email != null ? String(s.email) : null,
      seatLabel: s?.seatLabel != null ? String(s.seatLabel) : null,
    })),
  )
})
