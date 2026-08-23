/**
 * Publish-key policy for the RTMP gateway. The gateway calls this at PUBLISH
 * time — the earliest moment the stream key is known — for three decisions:
 *   - `publishKey`: is this token an event publish key? If not (per-student key
 *     / per-event token), the gateway relays the stream name VERBATIM and SRS'
 *     own on_publish paths apply unchanged.
 *   - `requireAccountAuth`: for publish-key events — may a connection that
 *     skipped the authmod dance publish this key?
 *   - `windowOpen`: is the event inside its [startsAt, endsAt] window? When
 *     closed, the gateway rejects the publish with NetStream.Publish.BadName —
 *     OBS treats that as a terminal "invalid stream" and STOPS instead of
 *     auto-retrying forever (which is what a silent close causes).
 * Token-gated like the other /api/srs/rtmp-auth endpoints: never public.
 */
import { createError, getHeader, getQuery } from 'h3'
import { env } from '../../../utils/env'
import { EventsRepository } from '../../../repositories/events.repository'
import { isBlocked } from '../../../services/stream-bans'

export default defineEventHandler((event) => {
  if (env.mediaNodeAuthToken !== '' && getHeader(event, 'x-rtmp-auth') !== env.mediaNodeAuthToken) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const token = String(getQuery(event).token ?? '')
  const stream = String(getQuery(event).stream ?? '').trim()
  const row = token ? EventsRepository.findByPublishKey(token) : undefined
  const now = Date.now()
  const windowOpen =
    !row || row.status === 'archived'
      ? true // unknown tokens are SRS' problem; archived handled below
      : (!row.startsAt || now >= row.startsAt.getTime()) && (!row.endsAt || now <= row.endsAt.getTime())
  return {
    publishKey: !!row,
    requireAccountAuth: true, // account auth is mandatory for every event
    windowOpen: row?.status === 'archived' ? false : windowOpen,
    // Permanent ban (site-wide or this event) keyed by the publisher's
    // account email — the gateway's synthesized stream name IS the email for
    // authenticated publishers (all events require auth). ip- fallback names
    // simply never match a ban.
    banned: !!stream && isBlocked(stream, row?.id ?? null),
  }
})
