/**
 * Publish authorization. Called from on_publish BEFORE allowing a stream.
 *
 * OBS stream key = `${streamName}?token=${plaintext}` → SRS splits it into
 * `stream` = streamName and `param` = "?token=plaintext" in the on_publish body.
 *
 * Two credential kinds, both honoured, both time-window-gated:
 *   1. per-student stream key — looked up by streamName; the token verifies
 *      against stream_keys.token_hash. Resolves student attribution.
 *   2. per-event shared credential — when no stream key matches, the token is
 *      checked against events.publish_token_hash (prefix-indexed, argon2id) and,
 *      failing that, against events.publish_key (plaintext, direct compare —
 *      the retrievable key shown on the participant guide). Lets an organizer
 *      hand the whole class one credential valid only inside the window; the
 *      stream NAME (account email) stays unique per contestant, so the class can
 *      stream concurrently with one shared key.
 *
 * A stream is only allowed while inside its event's [startsAt, endsAt] window
 * (each bound enforced only when set). Unknown stream names / keys are always
 * rejected — admission is not configurable.
 */
import { StreamKeysRepository } from '../repositories/stream-keys.repository'
import { EventsRepository } from '../repositories/events.repository'
import { EnrollmentsRepository } from '../repositories/enrollments.repository'
import { StudentsRepository } from '../repositories/students.repository'
import { verifyToken } from '../utils/token'
import type { Event } from '../database/schema'

export interface AuthContext {
  stream: string
  param: string
}

export interface AuthAllow {
  allow: true
  eventId: number | null
  streamKeyId: number
  studentLabel: string | null
}
export interface AuthReject {
  allow: false
  reason: string
}

export type AuthResult = AuthAllow | AuthReject

export function parseToken(param: string): string | null {
  if (!param) return null
  const q = param.startsWith('?') ? param.slice(1) : param
  return new URLSearchParams(q).get('token')
}

/**
 * Enforce the event's scheduled window. Returns a reject reason when the
 * publisher is outside the window, or null when within it. A bound that is null
 * (unset) is not enforced — so an event with no times is always in-window.
 */
/** human reason for a non-live status at publish time */
function publishClosedReason(status: string | undefined): string {
  switch (status) {
    case undefined:
      return 'event closed'
    case 'draft':
      return 'event not published yet'
    case 'scheduled':
      return 'event not started yet'
    case 'ended':
      return 'event ended'
    default:
      return 'event closed'
  }
}

function withinWindow(e: Pick<Event, 'startsAt' | 'endsAt'>): string | null {
  const now = Date.now()
  if (e.startsAt && now < e.startsAt.getTime()) return 'event not started'
  if (e.endsAt && now > e.endsAt.getTime()) return 'event ended'
  return null
}

/** Resolve an event by its per-event publish token (prefix lookup + verify). */
async function findEventByPublishToken(token: string): Promise<Event | null> {
  if (token.length < 8) return null // prefix must be stable; short tokens skip
  const candidates = EventsRepository.findByPublishTokenPrefix(token.slice(0, 8))
  for (const e of candidates) {
    if (!e.publishTokenHash) continue
    if (await verifyToken(token, e.publishTokenHash)) return e
  }
  return null
}

export async function authorizePublish(ctx: AuthContext): Promise<AuthResult> {
  const keys = StreamKeysRepository.findAllByStreamName(ctx.stream)
  const token = parseToken(ctx.param)

  // Path 1 — per-student stream key (by streamName).
  if (keys.length > 0 && token) {
    for (const key of keys) {
      if (key.revoked) continue
      if (!(await verifyToken(token, key.tokenHash))) continue

      const event = EventsRepository.findById(key.eventId)
      if (!event || event.status !== 'live') {
        // only LIVE accepts streams: draft is admin-only, scheduled hasn't
        // opened, ended/archived are closed
        return { allow: false, reason: publishClosedReason(event?.status) }
      }
      const windowReason = withinWindow(event)
      if (windowReason) return { allow: false, reason: windowReason }

      StreamKeysRepository.touch(key.id)
      return {
        allow: true,
        eventId: event.id,
        streamKeyId: key.id,
        studentLabel: resolveStudentLabel(key.enrollmentId),
      }
    }
  }

  // Path 2 — shared event credentials (fallback when no student key matched):
  //   (a) the per-event publish token (argon2id-verified), or
  //   (b) the per-event publish key (plaintext, direct compare — shown on the
  //       participant guide). Either lets an organizer hand the whole class one
  //       credential; the stream NAME stays unique per contestant (their account
  //       email), so concurrent publishing still works with one shared key.
  if (token) {
    const event = (await findEventByPublishToken(token)) ?? EventsRepository.findByPublishKey(token) ?? null
    if (event) {
      if (event.status !== 'live') return { allow: false, reason: publishClosedReason(event.status) }
      const windowReason = withinWindow(event)
      if (windowReason) return { allow: false, reason: windowReason }
      return { allow: true, eventId: event.id, streamKeyId: -1, studentLabel: null }
    }
  }

  // Path 3 — nothing matched.
  if (keys.length > 0) {
    // streamName is known but the token didn't satisfy any key or the event token.
    if (!token) return { allow: false, reason: 'missing token' }
    return { allow: false, reason: keys.some((k) => !k.revoked) ? 'bad token' : 'key revoked' }
  }
  // Unknown stream names are always rejected — publish admission is not
  // configurable (the gateway requires a valid event key for everyone).
  return { allow: false, reason: 'unknown stream name' }
}

function resolveStudentLabel(enrollmentId: number | null): string | null {
  if (!enrollmentId) return null
  const enr = EnrollmentsRepository.findById(enrollmentId)
  if (!enr) return null
  const student = StudentsRepository.findById(enr.studentId)
  return student ? student.name : null
}
