/**
 * Stream lifecycle orchestrator — the rewrite's core. Ports check_server.py's
 * check_stream + async_check_stream into a single publish/unpublish flow with a
 * live-metrics poll loop (Python only probed once; we poll every pollIntervalMs
 * to feed the realtime panel and catch mid-stream setting changes).
 *
 * Flow (see plan "Publishing/Recording lifecycle"):
 *   on_publish  → authorizePublish (reject → insert rejected session + audit, return)
 *               → insert session(allowed) → emit session:start → return "0"
 *                 immediately → fire-and-forget monitorSession()
 *   monitor     → startRecording → wait → loop: probe (under semaphore) →
 *                 update metrics + emit → compare limits → kick/flag/markCompliant
 *   on_unpublish→ mark ended → stopRecording (archive/discard) → emit session:stop
 */
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import { EventsRepository } from '../repositories/events.repository'
import { getConfig, getLimitsFor } from '../utils/config-store'
import { AsyncSemaphore } from '../utils/semaphore'
import { sleep } from '../utils/process'
import { buildFlvPullUrl } from '../utils/srs-url'
import { probeStream, type ProbeResult } from './probe'
import * as recorder from './recorder'
import { authorizePublish } from './access-control'
import { audit } from './audit'
import { emit } from '../utils/bus'
import type { Limits } from '#shared/config'
import type {
  SessionSnapshot,
  SessionStatus,
  ViolationSnapshot,
} from '#shared/events'

/** Caps concurrent ffprobe checks (Phase 4 hot-reload calls setMax). */
export const probeSemaphore = new AsyncSemaphore(getConfig().concurrency.probeMax)

interface Metrics {
  width: number | null
  height: number | null
  fps: number | null
  bitrateKbps: number | null
  status: SessionStatus
  compliant: boolean
}

interface ActiveSession {
  sessionId: number
  eventId: number | null
  streamName: string
  app: string
  vhost: string
  clientId: string
  startedAtMs: number
  active: boolean
}

/** keyed by streamName */
const active = new Map<string, ActiveSession>()

export interface PublishContext {
  app: string
  stream: string
  vhost: string
  clientId: string
  param: string
  eventId?: number | null
  streamKeyId?: number | null
  studentLabel?: string | null
}

/** on_publish: authorize, record the session, allow, kick off monitoring. */
export async function handlePublish(
  ctx: PublishContext,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  // Authorize before anything else: a rejected publisher never starts monitoring.
  const auth = await authorizePublish({ stream: ctx.stream, param: ctx.param })
  if (!auth.allow) {
    const now = new Date()
    PublishSessionsRepository.insert({
      eventId: ctx.eventId ?? null,
      streamKeyId: ctx.streamKeyId ?? null,
      streamName: ctx.stream,
      srsClientId: ctx.clientId || null,
      status: 'rejected',
      rejectReason: auth.reason,
      startedAt: now,
      endedAt: now,
    })
    // No session:start broadcast: rejected publishers (bad key, closed window…)
    // never belong on the LIVE panel — a retrying OBS would flood it with rows.
    // The rejection stays queryable in the audit log and sessions history.
    audit('warn', 'access', `publish rejected: ${ctx.stream} (${auth.reason})`, {
      actor: ctx.stream,
      streamName: ctx.stream,
      detail: { reason: auth.reason, clientId: ctx.clientId },
    })
    return { allow: false, reason: auth.reason }
  }

  // enrich ctx with the resolved event/key/student so the session row + monitor
  // carry the right associations (-1 = open access, no key)
  ctx.eventId = auth.eventId
  ctx.streamKeyId = auth.streamKeyId > 0 ? auth.streamKeyId : null
  ctx.studentLabel = auth.studentLabel

  const row = PublishSessionsRepository.insert({
    eventId: ctx.eventId ?? null,
    streamKeyId: ctx.streamKeyId ?? null,
    streamName: ctx.stream,
    srsClientId: ctx.clientId || null,
    status: 'allowed',
    startedAt: new Date(),
  })

  // Supersede: an older OPEN session under the same stream name can only be a
  // zombie (SRS allows one live publisher per name; hot-reloaded monitor loops
  // and lost on_unpublish hooks leave orphans). Close them now so the panel
  // never shows two "Publishing" rows for one person.
  for (const stale of PublishSessionsRepository.findActive().filter(
    (s) => s.streamName === ctx.stream && s.id !== row.id,
  )) {
    PublishSessionsRepository.markEnded(stale.id, stale.compliant ? 'compliant' : 'ended', row.startedAt)
    audit('warn', 'publish', `superseded zombie session #${stale.id} (${ctx.stream})`, {
      streamName: ctx.stream,
      detail: { supersededBy: row.id },
    })
  }

  const session: ActiveSession = {
    sessionId: row.id,
    eventId: ctx.eventId ?? null,
    streamName: ctx.stream,
    app: ctx.app,
    vhost: ctx.vhost,
    clientId: ctx.clientId,
    startedAtMs: row.startedAt.getTime(),
    active: true,
  }
  active.set(ctx.stream, session)

  emit(
    'session:start',
    snapshot(session, { width: null, height: null, fps: null, bitrateKbps: null, status: 'allowed', compliant: false }),
  )
  audit('info', 'publish', `publish started: ${ctx.stream}`, {
    actor: ctx.stream,
    eventId: ctx.eventId ?? null,
    streamName: ctx.stream,
    detail: { clientId: ctx.clientId, app: ctx.app, studentLabel: ctx.studentLabel ?? null },
  })

  // fire-and-forget — must not delay the "0" response (already sent by caller route)
  void monitorSession(session, ctx.studentLabel ?? null)

  return { allow: true }
}

/** on_unpublish: finalize, archive/discard recording, emit stop. */
export async function handleUnpublish(ctx: {
  app: string
  stream: string
  vhost: string
}): Promise<void> {
  const session = active.get(ctx.stream)
  if (session) {
    session.active = false
    active.delete(ctx.stream)
  }

  if (session) {
    const prev = PublishSessionsRepository.findById(session.sessionId)
    const finalStatus: SessionStatus =
      prev?.status === 'killed'
        ? 'killed'
        : prev?.compliant
          ? 'compliant'
          : 'ended'
    const endedAt = new Date()
    PublishSessionsRepository.markEnded(session.sessionId, finalStatus, endedAt)
    emit(
      'session:stop',
      snapshot(
        session,
        {
          width: prev?.width ?? null,
          height: prev?.height ?? null,
          fps: prev?.fps ?? null,
          bitrateKbps: prev?.bitrateKbps ?? null,
          status: finalStatus,
          compliant: prev?.compliant ?? false,
        },
        endedAt.getTime(),
      ),
    )
    await recorder.stopRecording(
      session.streamName,
      session.eventId,
      session.sessionId,
      null,
    )
  }
  audit('info', 'publish', `publish ended: ${ctx.stream}`, { actor: ctx.stream, streamName: ctx.stream })
}

/** Background probe + limit loop for one session. */
async function monitorSession(s: ActiveSession, studentLabel: string | null): Promise<void> {
  const event = s.eventId ? (EventsRepository.findById(s.eventId) ?? null) : null

  recorder.startRecording(s.streamName, s.app, s.vhost, s.clientId)
  await sleep(getConfig().probe.waitMs)

  const metrics: Metrics = {
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    status: 'allowed',
    compliant: false,
  }

  while (s.active) {
    const cfg = getConfig()
    const limits = getLimitsFor(event)
    const pullUrl = buildFlvPullUrl(s.streamName)
    const result = await probeSemaphore.run(() => probeStream(pullUrl))
    if (!s.active) break

    if (result) {
      metrics.width = result.width
      metrics.height = result.height
      metrics.fps = result.fps
      metrics.bitrateKbps = result.bitrateKbps
      persistMetrics(s.sessionId, metrics)
      emit('session:metric', snapshot(s, metrics))

      const reasons = checkLimits(result, limits)
      if (reasons.length > 0) {
        metrics.status = 'violating'
        persistStatus(s.sessionId, 'violating')
        emit('session:violation', {
          ...snapshot(s, metrics),
          reasons,
        } as ViolationSnapshot)
        audit('warn', 'publish', `violation: ${s.streamName} (${reasons.join('; ')})`, {
          actor: s.streamName,
          eventId: s.eventId,
          streamName: s.streamName,
          detail: { reasons, ...result },
        })
        // violations flag + keep monitoring; enforcement is manual (ban) —
        // the old auto-kick config path was removed with the kick mechanism
      } else if (!metrics.compliant) {
        metrics.compliant = true
        metrics.status = 'compliant'
        persistStatus(s.sessionId, 'compliant', undefined, true)
        recorder.markCompliant(s.streamName, result.width, result.height, result.fps || undefined)
        emit('session:metric', snapshot(s, metrics))
      }
    }

    if (!s.active) break
    await sleep(cfg.probe.pollIntervalMs)
  }
}

function checkLimits(r: ProbeResult, l: Limits): string[] {
  const reasons: string[] = []
  if ((l.maxWidth > 0 && r.width > l.maxWidth) || (l.maxHeight > 0 && r.height > l.maxHeight)) {
    reasons.push(`resolution ${r.width}x${r.height} > ${l.maxWidth}x${l.maxHeight}`)
  }
  if (l.maxFps > 0 && r.fps > l.maxFps) {
    reasons.push(`fps ${r.fps.toFixed(2)} > ${l.maxFps}`)
  }
  if (l.maxBitrateKbps > 0 && r.bitrateKbps > l.maxBitrateKbps) {
    reasons.push(`bitrate ${r.bitrateKbps}kbps > ${l.maxBitrateKbps}kbps`)
  }
  return reasons
}

function persistMetrics(sessionId: number, m: Metrics): void {
  PublishSessionsRepository.updateMetrics(sessionId, {
    width: m.width,
    height: m.height,
    fps: m.fps,
    bitrateKbps: m.bitrateKbps,
  })
}

function persistStatus(
  sessionId: number,
  status: SessionStatus,
  endedAt?: Date,
  compliant?: boolean,
): void {
  PublishSessionsRepository.updateStatus(sessionId, status, { endedAt, compliant })
}

function snapshot(s: ActiveSession, m: Metrics, endedAt: number | null = null): SessionSnapshot {
  return {
    sessionId: s.sessionId,
    eventId: s.eventId,
    streamName: s.streamName,
    status: m.status,
    srsClientId: s.clientId || null,
    nodeId: null, // local session — this backend owns the stream
    width: m.width,
    height: m.height,
    fps: m.fps,
    bitrateKbps: m.bitrateKbps,
    compliant: m.compliant,
    rejectReason: null,
    startedAt: s.startedAtMs,
    endedAt,
  }
}

/** Phase 4 hot-reload hook: resize the probe concurrency cap. */
export function setProbeConcurrency(n: number): void {
  probeSemaphore.setMax(n)
}
