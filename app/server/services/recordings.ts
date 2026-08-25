/**
 * Recording catalog: list/filter, metadata, on-disk path resolution, delete.
 * Files live under env.recordDir/{date}/{name}_{ts}.mp4 (or .flv fallback);
 * `filePath` stored in DB is relative to recordDir. DB access goes through
 * RecordingsRepository; this layer owns filtering, file I/O, and DTO mapping.
 */
import { statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createError } from 'h3'
import { RecordingsRepository } from '../repositories/recordings.repository'
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import type { Recording } from '../database/schema'
import { env } from '../utils/env'
import { audit } from './audit'

export interface RecordingView {
  id: number
  eventId: number | null
  sessionId: number | null
  streamName: string
  studentLabel: string | null
  filePath: string
  sizeBytes: number
  durationSec: number | null
  avgFps: number | null
  width: number | null
  height: number | null
  startedAt: number
  endedAt: number | null
  retainedUntil: number | null
  createdAt: number
}

export interface RecordingFilters {
  eventId?: number | null
  date?: string | null // YYYY-MM-DD (local day)
  q?: string | null // matches streamName or studentLabel
}

function toView(r: Recording): RecordingView {
  return {
    id: r.id,
    eventId: r.eventId ?? null,
    sessionId: r.sessionId ?? null,
    streamName: r.streamName,
    studentLabel: r.studentLabel ?? null,
    filePath: r.filePath,
    sizeBytes: r.sizeBytes,
    durationSec: r.durationSec ?? null,
    avgFps: r.avgFps ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt ? r.endedAt.getTime() : null,
    retainedUntil: r.retainedUntil ? r.retainedUntil.getTime() : null,
    createdAt: r.createdAt.getTime(),
  }
}

function localDay(ms: number): string {
  const d = new Date(ms)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${da}`
}

export function listRecordings(filters: RecordingFilters = {}): RecordingView[] {
  let rows = RecordingsRepository.findAll()

  if (filters.eventId && filters.eventId > 0) {
    rows = rows.filter((r) => r.eventId === filters.eventId)
  }
  if (filters.date) {
    rows = rows.filter((r) => localDay(r.startedAt.getTime()) === filters.date)
  }
  if (filters.q) {
    const q = filters.q.toLowerCase()
    rows = rows.filter(
      (r) => r.streamName.toLowerCase().includes(q) || (r.studentLabel ?? '').toLowerCase().includes(q),
    )
  }
  return rows.map(toView)
}

export function getRecording(id: number): RecordingView {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  return toView(row)
}

export interface ResolvedFile {
  absPath: string
  filename: string
  mime: string
  size: number
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.flv': 'video/x-flv',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
}

/** Which media node holds this recording's files (null = local disk). Falls
 *  back to the publish session for rows recorded before the column existed. */
export function hostingNodeIdOf(row: Recording): string | null {
  if (row.nodeId) return row.nodeId
  if (row.sessionId) {
    const s = PublishSessionsRepository.findById(row.sessionId)
    if (s?.nodeId) return s.nodeId
  }
  return null
}

/** All segment paths (relative to RECORD_DIR) for a recording, chronological.
 *  NODE-hosted rows return the DB list as-is — the files live on the node and
 *  are materialized on demand (materializeRemoteSegments); only LOCAL rows are
 *  filtered by on-disk existence. */
export function resolveSegments(id: number): string[] {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  const segs: string[] = row.segments ? JSON.parse(row.segments) : [row.filePath]
  if (hostingNodeIdOf(row)) return segs
  return segs.filter((rel) => {
    try {
      statSync(join(env.recordDir, rel))
      return true
    } catch {
      return false
    }
  })
}

export function resolveRecordingFile(id: number): ResolvedFile {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  if (hostingNodeIdOf(row)) {
    // node-hosted: served via the relay pipeline (multi-segment branch, or a
    // single raw segment once materialized) — never statSync local disk
    const ext = row.filePath.slice(row.filePath.lastIndexOf('.')).toLowerCase()
    return {
      absPath: join(env.recordDir, row.filePath), // virtual; only the ext is used
      filename: row.filePath.split('/').pop() ?? `recording-${id}${ext}`,
      mime: MIME[ext] ?? 'application/octet-stream',
      size: row.sizeBytes,
    }
  }
  const absPath = join(env.recordDir, row.filePath)
  let size: number
  try {
    size = statSync(absPath).size
  } catch {
    throw createError({ statusCode: 410, statusMessage: 'recording file missing on disk' })
  }
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase()
  return {
    absPath,
    filename: row.filePath.split('/').pop() ?? `recording-${id}${ext}`,
    mime: MIME[ext] ?? 'application/octet-stream',
    size,
  }
}

export function deleteRecording(id: number): void {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  const segs: string[] = row.segments ? JSON.parse(row.segments) : [row.filePath]
  for (const rel of segs) {
    try {
      rmSync(join(env.recordDir, rel), { force: true })
    } catch {
      // file already gone — still drop the row
    }
  }
  // Node-hosted rows: the files live on the node's disk (not ours) — tell the
  // node to delete them over the control channel. Best-effort: an offline
  // node keeps its files (logged); the row is dropped either way.
  const hostNode = hostingNodeIdOf(row)
  if (hostNode && !sendRecordingDelete(hostNode, segs)) {
    console.warn(`[recordings] node ${hostNode} offline — segment files left on node disk for ${row.streamName}`)
  }
  RecordingsRepository.remove(id)
  audit('warn', 'recording', `recording deleted: ${row.streamName}`, {
    eventId: row.eventId ?? undefined,
    streamName: row.streamName,
    detail: { id, filePath: row.filePath },
  })
}

/* ------------------- node-hosted recording file relay ------------------- */
import { mkdirSync, writeFileSync } from 'node:fs'
import { wsConnected, wsRpcRecordingPull, cancelRecordingPull, sendRecordingDelete } from './media-node-ws'

/**
 * Delivery hub: chunk/end notifications are consumed at the TRANSPORT level
 * (media-node-ws.ts, the protobuf WS) and dispatched here by reqId. Chunks
 * arrive as raw protobuf bytes.
 */
type RecChunkHandler = (payload: { reqId?: string; data?: Uint8Array }) => void
type RecEndHandler = (payload: { reqId?: string; error?: string }) => void
const pendingPulls = new Map<string, { onData: RecChunkHandler; onEnd: RecEndHandler }>()

export function dispatchRecChunk(payload: { reqId?: string; data?: Uint8Array }): void {
  pendingPulls.get(payload?.reqId ?? '')?.onData(payload)
}
export function dispatchRecEnd(payload: { reqId?: string; error?: string }): void {
  const entry = pendingPulls.get(payload?.reqId ?? '')
  if (entry) {
    entry.onEnd(payload)
    pendingPulls.delete(payload?.reqId ?? '')
  }
}

const REC_PULL_TIMEOUT_MS = 30_000

export interface MaterializedSegments {
  /** absolute paths of the downloaded copies (concat-list ready) */
  absPaths: string[]
  /** the temp dir they live in (caller removes when done) */
  dir: string
}

/**
 * Pull a node-hosted recording's segments over the control channel
 * (recording_pull RPC + raw-bytes recording_chunk events on the protobuf WS
 * transport) into a temp dir under RECORD_DIR/_remote. The existing local
 * serve pipeline (ffmpeg concat) then runs unchanged against the copies.
 * Sequential per segment; sizes are recording-sized (tens–hundreds of MB) so
 * this is a download-time cost, not a listing one.
 */
export async function materializeRemoteSegments(
  nodeId: string,
  segs: string[],
  recordingId: number,
): Promise<MaterializedSegments> {
  if (!wsConnected(nodeId)) throw createError({ statusCode: 502, statusMessage: 'hosting node is offline' })

  const dir = join(env.recordDir, '_remote', nodeId.replace(/[^\w.-]/g, '_'), String(recordingId))
  mkdirSync(dir, { recursive: true })
  const absPaths: string[] = []

  for (const rel of segs) {
    const safe = rel.replace(/\.\.(\/|\\)/g, '').replace(/^\/+/, '')
    const abs = join(dir, safe.replaceAll('/', '__'))
    const reqId = `rec-${recordingId}-${Math.random().toString(36).slice(2, 10)}`

    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false
      let lastActivity = Date.now()
      const cleanup = (): void => {
        pendingPulls.delete(reqId)
        clearInterval(stallTimer)
      }
      const stallTimer = setInterval(() => {
        if (Date.now() - lastActivity > REC_PULL_TIMEOUT_MS) {
          cancelRecordingPull(nodeId, reqId)
          finish(new Error('node file transfer stalled'))
        }
      }, 2_000)
      const finish = (err: Error | null): void => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else {
          try {
            writeFileSync(abs, Buffer.concat(chunks))
            absPaths.push(abs)
            resolve()
          } catch (e) {
            reject(e instanceof Error ? e : new Error('temp write failed'))
          }
        }
      }
      function onData(payload: { reqId?: string; data?: Uint8Array }): void {
        if (payload?.reqId !== reqId || !payload.data) return
        lastActivity = Date.now()
        chunks.push(Buffer.from(payload.data))
      }
      function onEnd(payload: { reqId?: string; error?: string }): void {
        if (payload?.reqId !== reqId) return
        finish(payload.error ? new Error(`node: ${payload.error}`) : null)
      }
      pendingPulls.set(reqId, { onData, onEnd })
      wsRpcRecordingPull(nodeId, reqId, safe).catch((e: unknown) => {
        finish(e instanceof Error ? e : new Error('node did not start the file transfer'))
      })
    })
  }
  return { absPaths, dir }
}
