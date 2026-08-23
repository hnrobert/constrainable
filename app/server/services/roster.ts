/**
 * Roster management (business logic): list enrollments, CSV bulk import (upsert
 * students + enrollments), remove an enrollment (and revoke its keys). DB access
 * flows through the repositories; this layer composes the cross-table steps and
 * audits.
 */
import { createError } from 'h3'
import { EventsRepository } from '../repositories/events.repository'
import { StudentsRepository } from '../repositories/students.repository'
import { EnrollmentsRepository } from '../repositories/enrollments.repository'
import { StreamKeysRepository } from '../repositories/stream-keys.repository'
import { audit } from './audit'

export interface RosterEntry {
  enrollmentId: number
  studentId: number
  studentNumber: string
  name: string
  email: string | null
  seatLabel: string | null
  status: string
  hasKey: boolean
}

export interface RosterStudentInput {
  studentNumber: string
  name: string
  email?: string | null
  seatLabel?: string | null
}

function requireEvent(eventId: number): void {
  if (!EventsRepository.findById(eventId)) {
    throw createError({ statusCode: 404, statusMessage: 'event not found' })
  }
}

export function listRoster(eventId: number): RosterEntry[] {
  requireEvent(eventId)
  const rows = EnrollmentsRepository.listWithStudentByEvent(eventId)
  const keyed = new Set(StreamKeysRepository.findActiveEnrollmentIdsByEvent(eventId))

  return rows.map((r) => ({
    enrollmentId: r.enrollment.id,
    studentId: r.enrollment.studentId,
    studentNumber: r.studentNumber,
    name: r.name,
    email: r.email ?? null,
    seatLabel: r.enrollment.seatLabel ?? null,
    status: r.enrollment.status,
    hasKey: r.enrollment.id != null && keyed.has(r.enrollment.id),
  }))
}

export interface ImportResult {
  created: number
  updated: number
  total: number
}

export function importRoster(eventId: number, input: RosterStudentInput[]): ImportResult {
  requireEvent(eventId)
  let created = 0
  let updated = 0

  for (const s of input) {
    const studentNumber = (s.studentNumber ?? '').trim()
    const name = (s.name ?? '').trim()
    if (!studentNumber || !name) continue

    const email = s.email?.trim() || null
    let student = StudentsRepository.findByStudentNumber(studentNumber)
    if (!student) {
      student = StudentsRepository.insert({ studentNumber, name, email })
    } else {
      StudentsRepository.updateProfile(student.id, name, email ?? student.email)
    }

    const existing = EnrollmentsRepository.findByEventAndStudent(eventId, student.id)
    if (existing) {
      EnrollmentsRepository.updateSeat(existing.id, s.seatLabel?.trim() || null, 'active')
      updated += 1
    } else {
      EnrollmentsRepository.insert({
        eventId,
        studentId: student.id,
        seatLabel: s.seatLabel?.trim() || null,
        status: 'active',
      })
      created += 1
    }
  }

  audit('info', 'admin', `roster imported: +${created} ~${updated}`, {
    eventId,
    detail: { created, updated, total: input.length },
  })
  return { created, updated, total: input.length }
}

export function removeEnrollment(eventId: number, enrollmentId: number): void {
  requireEvent(eventId)
  const enr = EnrollmentsRepository.findById(enrollmentId)
  if (!enr || enr.eventId !== eventId) {
    throw createError({ statusCode: 404, statusMessage: 'enrollment not found' })
  }

  // revoke any keys tied to this enrollment before removing the link
  StreamKeysRepository.revokeActiveByEnrollment(enrollmentId)
  EnrollmentsRepository.remove(enrollmentId)
  audit('warn', 'admin', `roster entry removed (enrollment ${enrollmentId})`, { eventId })
}
