/**
 * Stale-session reconciler. When a publisher dies without a clean unpublish
 * (SRS restart, lost hook, app restart mid-stream), the session row stays
 * open forever and the realtime panel shows ghosts. Two liveness models:
 *
 *  - LOCAL sessions (nodeId null, app-managed SRS): compare against the
 *    streams actually live in the local SRS API. Fail-safe: API unreachable
 *    → skip the sweep (an outage must never reap live sessions).
 *  - REMOTE sessions (nodeId set, hosted on a media node): the node's
 *    monitor reports publish:metrics every ~5s — a session whose last
 *    metric is older than REMOTE_STALE_MS (or that never got one and is
 *    older than REMOTE_GRACE_MS) is a ghost. Close it. (The app CANNOT
 *    query the node's SRS directly; the metrics heartbeat IS the signal.)
 */
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import type { PublishSession } from '../database/schema'
import { listLiveStreamNames } from './srs-client'
import * as recorder from './recorder'
import { audit } from './audit'
import { emit } from '../utils/bus'
import type { SessionSnapshot, SessionStatus } from '#shared/events'

/** remote session without metrics for this long = ghost */
const REMOTE_STALE_MS = 90_000
/** remote session that NEVER reported metrics is a ghost after this long */
const REMOTE_GRACE_MS = 120_000

export async function reconcileStaleSessions(): Promise<void> {
  const open = PublishSessionsRepository.findActive()
  if (open.length === 0) return

  const local = open.filter((s) => !s.nodeId)
  const remote = open.filter((s) => !!s.nodeId)

  // --- remote: metrics-heartbeat staleness ---
  const now = Date.now()
  for (const s of remote) {
    const last = s.lastMetricAt?.getTime() ?? null
    const stale = last != null
      ? now - last > REMOTE_STALE_MS
      : now - s.startedAt.getTime() > REMOTE_GRACE_MS
    if (!stale) continue
    await closeGhost(s, `node ${s.nodeId} stopped reporting (last metric ${last ? `${Math.round((now - last) / 1000)}s ago` : 'never'})`)
  }
  if (local.length === 0) return

  // --- local: compare against the local SRS API ---
  const live = await listLiveStreamNames()
  if (live === null) return // SRS unreachable — skip this sweep entirely

  // Among open sessions, keep only the NEWEST per stream name: SRS allows one
  // live publisher per name, so an older open row with the same name is a
  // zombie even while the name itself is live.
  const newestByName = new Map<string, number>()
  for (const s of local) {
    const cur = newestByName.get(s.streamName)
    if (cur == null || s.id > cur) newestByName.set(s.streamName, s.id)
  }

  for (const s of local) {
    if (live.has(s.streamName) && newestByName.get(s.streamName) === s.id) continue
    await closeGhost(s, 'not live in SRS anymore')
  }
}

async function closeGhost(s: PublishSession, reason: string): Promise<void> {
  const finalStatus: SessionStatus = s.compliant ? 'compliant' : 'ended'
  const endedAt = new Date()
  PublishSessionsRepository.markEnded(s.id, finalStatus, endedAt)
  // finalize any recorder temp file still holding this stream's handle
  // (local sessions only — remote recording lives on the node)
  if (!s.nodeId) await recorder.stopRecording(s.streamName, s.eventId, s.id, null)
  emit('session:stop', {
    sessionId: s.id,
    eventId: s.eventId,
    streamName: s.streamName,
    status: finalStatus,
    srsClientId: s.srsClientId,
    nodeId: null,
    width: s.width,
    height: s.height,
    fps: s.fps,
    bitrateKbps: s.bitrateKbps,
    audioKbps: s.audioKbps ?? null,
    compliant: !!s.compliant,
    rejectReason: s.rejectReason,
    startedAt: s.startedAt.getTime(),
    endedAt: endedAt.getTime(),
  } satisfies SessionSnapshot)
  audit('warn', 'publish', `reconciled stale session: ${s.streamName} (#${s.id}) — ${reason}`, {
    actor: s.streamName,
    streamName: s.streamName,
    detail: { sessionId: s.id, reason },
  })
  console.log(`[reconcile] closed stale session #${s.id} ${s.streamName} (${finalStatus}, ${reason})`)
}
