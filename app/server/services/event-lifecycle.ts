/**
 * Event lifecycle automation:
 *   - AUTO-END: a 'live' or 'scheduled' event whose endsAt has passed flips to
 *     'ended' and every active publish session of that event is CUT (node
 *     relays get node:kick, closing both the relay and the OBS connection —
 *     OBS sees a terminal rejection, not a hang). idempotent per event.
 *   - AUTO-START (opt-in simplicity): a 'scheduled' event whose startsAt has
 *     arrived flips to 'live' so the publish window is enforced purely by the
 *     times, without an admin flipping statuses by hand.
 * Runs on a short interval from plugins/03-event-lifecycle.ts; the publish
 * gate also checks the window per-connection, so automation timing only
 * affects mid-stream cutoffs and status labels, never admission correctness.
 */
import { EventsRepository } from '../repositories/events.repository'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import { kickStream } from './media-node-ws'
import { audit } from './audit'
import type { Event } from '../database/schema'

export interface LifecycleResult {
  started: number
  ended: number
  killed: number
}

export function runEventLifecycle(): LifecycleResult {
  const now = Date.now()
  const out: LifecycleResult = { started: 0, ended: 0, killed: 0 }

  for (const ev of EventsRepository.findAll()) {
    if (ev.status === 'scheduled' && ev.startsAt && ev.startsAt.getTime() <= now) {
      EventsRepository.update(ev.id, { status: 'live' })
      out.started++
      audit('info', 'system', `event auto-started (window opened): ${ev.name}`, {
        eventId: ev.id,
        detail: { startsAt: ev.startsAt.getTime() },
      })
      continue
    }
    if ((ev.status === 'live' || ev.status === 'scheduled') && ev.endsAt && ev.endsAt.getTime() <= now) {
      out.killed += cutEventStreams(ev)
      EventsRepository.update(ev.id, { status: 'ended' })
      out.ended++
      audit('warn', 'system', `event auto-ended (window closed), streams cut: ${ev.name}`, {
        eventId: ev.id,
        detail: { endsAt: ev.endsAt.getTime() },
      })
    }
  }
  return out
}

/** Kill every ACTIVE publish session belonging to the event. */
function cutEventStreams(ev: Event): number {
  let cut = 0
  for (const s of PublishSessionsRepository.findActiveByEvent(ev.id)) {
    const reason = `event ended (window closed): ${ev.name}`
    let dead = false
    if (s.nodeId) {
      dead = kickStream(s.nodeId, s.streamName, reason)
    }
    if (!dead) {
      // local session or node offline — mark ended regardless; SRS-side
      // timeout/reconciler handles the leftovers.
      PublishSessionsRepository.markEnded(s.id, 'ended', new Date())
    }
    cut++
    audit('warn', 'publish', `stream cut at event end: ${s.streamName}`, {
      actor: s.streamName,
      eventId: ev.id,
      streamName: s.streamName,
      detail: { sessionId: s.id, reason, nodeKick: dead },
    })
  }
  return cut
}
