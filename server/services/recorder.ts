/**
 * ffmpeg recorder — direct port of check_server.py's recording management:
 *   startRecording  → ffmpeg copies the RTMP stream to a temp .flv from publish
 *   markCompliant   → flag the stream as eligible for archiving
 *   stopRecording   → on unpublish: remux compliant FLV→MP4 (keep .flv on
 *                     failure), delete temp for non-compliant streams
 *
 * `_recordings` dict + `_record_lock` → a plain Map (JS is single-threaded).
 */
import { mkdirSync, rmSync, renameSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { env } from '../utils/env'
import { getConfig } from '../utils/config-store'
import { safeName } from '../utils/filename'
import { buildFlvPullUrl } from '../utils/srs-url'
import { awaitExitOrKill, quitFfmpeg, readStream, type AnyProc } from '../utils/process'
import { RecordingsRepository } from '../repositories/recordings.repository'
import { emit } from '../utils/bus'

interface Handle {
  proc: AnyProc
  tmpPath: string
  startedAt: number // epoch ms
  compliant: boolean
  width: number | null
  height: number | null
  fps: number | null
}

/** keyed by streamName (app is constant "live" in our SRS config) */
const handles = new Map<string, Handle>()

/** Push-start: begin recording to a temp FLV immediately on publish. */
export function startRecording(
  streamName: string,
  app: string,
  vhost: string,
  clientId: string,
): void {
  const cfg = getConfig()
  if (!cfg.record.enabled) return
  // bounded concurrency: once at cap, new streams are not recorded (existing
  // recordings finish). Read fresh so a config change affects new publishes.
  if (handles.size >= cfg.record.maxConcurrency) {
    console.warn(
      `[recorder] at capacity (${handles.size}/${cfg.record.maxConcurrency}), skipping record for ${streamName}`,
    )
    return
  }
  if (handles.has(streamName)) return
  const tmpDir = join(env.recordDir, '_tmp')
  mkdirSync(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `${safeName(streamName)}_${clientId}.mkv`)
  const cmd = [
    env.ffmpegPath,
    '-y',
    '-v',
    'error',
    '-i',
    // HTTP-FLV pull: SRS's RTMP-play path starves on low-fps streams (see
    // srs-url.ts); the FLV path serves the same stream reliably.
    buildFlvPullUrl(streamName),
    '-map',
    '0',
    '-c',
    'copy',
    // Matroska is streamable while being written — this IS the archive file,
    // written in real time. No remux/transcode happens at stop.
    '-f',
    'matroska',
    tmpPath,
  ]
  const proc = Bun.spawn({ cmd, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
  handles.set(streamName, {
    proc,
    tmpPath,
    startedAt: Date.now(),
    compliant: false,
    width: null,
    height: null,
    fps: null,
  })
  console.log(`[recorder] started ${streamName}: ${tmpPath}`)
}

/** Mark compliant so stopRecording will archive it. Captures last-seen dims/fps. */
export function markCompliant(streamName: string, width?: number, height?: number, fps?: number): void {
  const h = handles.get(streamName)
  if (!h) return
  h.compliant = true
  if (width) h.width = width
  if (height) h.height = height
  if (fps) h.fps = fps
}

/** Push-end: archive (compliant) or discard (non-compliant) the temp recording. */
export async function stopRecording(
  streamName: string,
  eventId: number | null,
  sessionId: number | null,
  studentLabel: string | null,
): Promise<void> {
  const h = handles.get(streamName)
  if (!h) return
  handles.delete(streamName)
  await quitFfmpeg(h.proc, 10000)
  if (h.compliant) {
    await finalizeRecording(streamName, h, eventId, sessionId, studentLabel)
  } else {
    try {
      rmSync(h.tmpPath)
      console.log(`[recorder] discarded non-compliant temp for ${streamName}`)
    } catch {
      // already gone
    }
  }
}

/**
 * Finalize one recorded segment. NO transcoding here — the temp file is
 * already a real-time MKV archive; we only rename it into place and update the
 * DB. A user's re-publish appends to their existing row as a new segment
 * (chronological list); playback/download glue the segments on demand.
 */
async function finalizeRecording(
  streamName: string,
  h: Handle,
  eventId: number | null,
  sessionId: number | null,
  studentLabel: string | null,
): Promise<void> {
  const endedAt = new Date()
  const segDurSec = Math.max(0, Math.round((endedAt.getTime() - h.startedAt) / 1000))
  const { date, ts } = localParts(new Date(h.startedAt))
  const dateDir = join(env.recordDir, date)
  mkdirSync(dateDir, { recursive: true })
  const segPath = join(dateDir, `${safeName(streamName)}_${ts}.mkv`)
  try {
    renameSync(h.tmpPath, segPath)
  } catch (err) {
    console.error(`[recorder] failed to move segment for ${streamName}:`, err)
    return
  }
  const rel = relative(env.recordDir, segPath)
  let size = 0
  try {
    size = statSync(segPath).size
  } catch {
    // ignore
  }

  const prev =
    eventId != null ? RecordingsRepository.findMergeTarget(eventId, streamName) : undefined
  if (prev) {
    const segs: string[] = prev.segments ? JSON.parse(prev.segments) : [prev.filePath]
    segs.push(rel)
    RecordingsRepository.update(prev.id, {
      segments: JSON.stringify(segs),
      sizeBytes: prev.sizeBytes + size,
      durationSec: (prev.durationSec ?? 0) + segDurSec,
      avgFps:
        prev.avgFps && h.fps
          ? (prev.avgFps * (prev.durationSec ?? 0) + h.fps * segDurSec) /
            Math.max(1, (prev.durationSec ?? 0) + segDurSec)
          : (h.fps ?? prev.avgFps),
      width: h.width ?? prev.width,
      height: h.height ?? prev.height,
      endedAt,
    })
    emit('recording:ready', {
      id: prev.id,
      eventId,
      sessionId,
      streamName,
      studentLabel,
      filePath: prev.filePath,
      sizeBytes: prev.sizeBytes + size,
      durationSec: (prev.durationSec ?? 0) + segDurSec,
      startedAt: prev.startedAt.getTime(),
    })
    console.log(`[recorder] appended ${streamName} segment +${segDurSec}s to #${prev.id}`)
    return
  }

  const row = RecordingsRepository.insert({
    eventId,
    sessionId,
    streamName,
    studentLabel,
    filePath: rel,
    segments: JSON.stringify([rel]),
    sizeBytes: size,
    durationSec: segDurSec,
    avgFps: h.fps,
    width: h.width,
    height: h.height,
    startedAt: new Date(h.startedAt),
    endedAt,
  })
  emit('recording:ready', {
    id: row.id,
    eventId,
    sessionId,
    streamName,
    studentLabel,
    filePath: rel,
    sizeBytes: size,
    durationSec: segDurSec,
    startedAt: h.startedAt,
  })
  console.log(`[recorder] saved ${segPath} (${size} bytes, ${segDurSec}s, real-time mkv)`)
}

/** Local-time date parts (TZ-dependent; container TZ=Asia/Shanghai). */
function localParts(d: Date): { date: string; ts: string } {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return { date: `${y}-${mo}-${da}`, ts: `${y}${mo}${da}_${hh}${mi}${ss}` }
}
