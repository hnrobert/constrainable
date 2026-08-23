/**
 * Stream-key lifecycle (business logic): generation, listing, revocation.
 *
 * A key ties a student (via enrollment) to an SRS stream name plus a secret
 * token. The plaintext token is returned EXACTLY ONCE at generation time; only
 * its argon2id hash is persisted. Re-generating a key for the same
 * (event, stream name) rotates the token in place and clears any revoke. DB
 * access goes through the repositories; this layer owns token hashing,
 * uniqueness, and audit.
 */
import { createError } from 'h3'
import { EventsRepository } from '../repositories/events.repository'
import { StudentsRepository } from '../repositories/students.repository'
import { EnrollmentsRepository } from '../repositories/enrollments.repository'
import { StreamKeysRepository } from '../repositories/stream-keys.repository'
import type { StreamKey } from '../database/schema'
import { generateToken, hashToken, tokenPreview, streamNameFor } from '../utils/token'
import { audit } from './audit'

export interface GenerateKeyInput {
  studentNumber: string
  name: string
  email?: string | null
  seatLabel?: string | null
  /** explicit stream name; defaults to a sanitized student number */
  streamName?: string | null
}

export interface GeneratedKey {
  id: number
  streamName: string
  /** plaintext token — shown ONCE, then only the hash remains */
  token: string
  tokenPreview: string
  studentLabel: string
  studentNumber: string
}

export interface KeyView {
  id: number
  streamName: string
  tokenPreview: string
  revoked: boolean
  lastUsedAt: number | null
  createdAt: number
  studentNumber: string | null
  studentLabel: string | null
  seatLabel: string | null
}

function requireEventExists(eventId: number): void {
  if (!EventsRepository.findById(eventId)) {
    throw createError({ statusCode: 404, statusMessage: 'event not found' })
  }
}

export async function generateKeyForEvent(
  eventId: number,
  input: GenerateKeyInput,
): Promise<GeneratedKey> {
  requireEventExists(eventId)

  const studentNumber = input.studentNumber.trim()
  const name = input.name.trim()
  if (!studentNumber || !name) {
    throw createError({ statusCode: 400, statusMessage: 'studentNumber and name are required' })
  }

  // upsert student by student number
  const email = input.email?.trim() || null
  let student = StudentsRepository.findByStudentNumber(studentNumber)
  if (!student) {
    student = StudentsRepository.insert({ studentNumber, name, email })
  } else {
    StudentsRepository.updateProfile(student.id, name, email ?? student.email)
    student = StudentsRepository.findById(student.id)!
  }

  // find or create enrollment
  let enrollment = EnrollmentsRepository.findByEventAndStudent(eventId, student.id)
  if (!enrollment) {
    enrollment = EnrollmentsRepository.insert({
      eventId,
      studentId: student.id,
      seatLabel: input.seatLabel?.trim() || null,
      status: 'active',
    })
  }

  const baseName = streamNameFor(input.streamName?.trim() || studentNumber)
  const streamName = ensureUniqueStreamName(eventId, enrollment.id, baseName)

  const token = generateToken()
  const hash = await hashToken(token)
  const preview = tokenPreview(token)

  const existing = StreamKeysRepository.findByEventAndName(eventId, streamName)
  let id: number
  if (existing) {
    // rotate token in place, clear any revoke, (re)bind to this enrollment
    StreamKeysRepository.rotate(existing.id, {
      tokenHash: hash,
      tokenPreview: preview,
      enrollmentId: enrollment.id,
    })
    id = existing.id
  } else {
    id = StreamKeysRepository.insert({
      eventId,
      enrollmentId: enrollment.id,
      streamName,
      tokenHash: hash,
      tokenPreview: preview,
    }).id
  }

  audit('info', 'access', `key generated: ${streamName} (${student.name})`, {
    eventId,
    detail: { keyId: id, streamName, studentNumber, studentLabel: student.name },
  })

  return { id, streamName, token, tokenPreview: preview, studentLabel: student.name, studentNumber }
}

/**
 * Generate keys for every enrolled student in the event that doesn't already
 * have an active key. Returns the plaintext tokens ONCE (caller shows them).
 */
export async function generateKeysForUnkeyed(eventId: number): Promise<GeneratedKey[]> {
  requireEventExists(eventId)
  const enrollments = EnrollmentsRepository.listWithStudentByEvent(eventId)
  const keyed = new Set(StreamKeysRepository.findActiveEnrollmentIdsByEvent(eventId))

  const out: GeneratedKey[] = []
  for (const e of enrollments) {
    if (e.enrollment.id != null && keyed.has(e.enrollment.id)) continue
    out.push(
      await generateKeyForEvent(eventId, {
        studentNumber: e.studentNumber,
        name: e.name,
        email: e.email,
        seatLabel: e.enrollment.seatLabel,
      }),
    )
  }
  return out
}

export function listKeys(eventId: number): KeyView[] {
  return StreamKeysRepository.listWithStudentByEvent(eventId).map((r) =>
    toView(r.key, r.studentNumber, r.studentLabel, r.seatLabel),
  )
}

export function revokeKey(eventId: number, keyId: number): void {
  const row = StreamKeysRepository.findByEventAndId(eventId, keyId)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'key not found' })
  if (row.revoked) return
  StreamKeysRepository.revoke(keyId)
  audit('warn', 'access', `key revoked: ${row.streamName}`, {
    eventId,
    streamName: row.streamName,
    detail: { keyId },
  })
}

function ensureUniqueStreamName(eventId: number, enrollmentId: number, base: string): string {
  let name = base
  let n = 1
  for (;;) {
    const clash = StreamKeysRepository.findByEventAndName(eventId, name)
    if (!clash || clash.enrollmentId === enrollmentId) return name
    n += 1
    name = `${base}-${n}`
  }
}

function toView(
  key: StreamKey,
  studentNumber: string | null,
  studentLabel: string | null,
  seatLabel: string | null,
): KeyView {
  return {
    id: key.id,
    streamName: key.streamName,
    tokenPreview: key.tokenPreview,
    revoked: key.revoked,
    lastUsedAt: key.lastUsedAt ? key.lastUsedAt.getTime() : null,
    createdAt: key.createdAt.getTime(),
    studentNumber,
    studentLabel,
    seatLabel,
  }
}
