/**
 * Watch-path stream sanitizer ("clean variants").
 *
 * EVERY WHEP watch is answered from a re-encoded twin of the live stream
 * (clean-<stream>): x264 with bf=0 and a forced keyframe every 2s — immune
 * to the publisher-side B-frame / long-GOP settings that break WebRTC
 * decoding (bytes flow, zero frames decode). The twin is generated on
 * demand in THIS container (ffmpeg already ships here for the recording
 * concat), pulled from and pushed back to the hosting node's SRS over the
 * internal docker network; browsers still receive WebRTC/UDP from SRS
 * directly, exactly as before.
 *
 * Lifecycle: one twin per stream, shared by all viewers; reaped 2 minutes
 * after the last watch request (WHEP answers are one-shot — browsers never
 * signal viewer departure); hard concurrency cap CLEAN_MAX_CONCURRENT with
 * fallback to answering from the ORIGINAL stream when full. When a twin
 * dies, the node is told to wipe its DVR directory via the existing
 * recording_delete event (a no-extension rel path = directory sentinel).
 *
 * Naming: the "clean-" PREFIX is load-bearing — SRS treats everything after
 * the first '.' in a stream name as a parameter, so a "<stream>_clean"
 * suffix would collapse onto the ORIGINAL source. clean-hnrobert@qq.com
 * resolves to the distinct source "clean-hnrobert@qq".
 */
import { env } from '../utils/env'
import { sendRecordingDelete } from './media-node-ws'

const CLEAN_PREFIX = 'clean-'
const MAX_CONCURRENT = Number(process.env.CLEAN_MAX_CONCURRENT || '4')
const IDLE_TTL_MS = 2 * 60_000
const REAP_INTERVAL_MS = 30_000
const READY_TIMEOUT_MS = 2_000

/**
 * Derive the SRS address from the NODE-ADVERTISED FLV base (registered at
 * hello: SRS_FLV_BASE on the node, default http://<identifier>:38081). The
 * twin pulls RTMP (1935) and pushes back over the same host — the
 * advertisement is the deployment's single source of truth for "how to
 * reach this node's SRS", and it must resolve from THIS container. (Do NOT
 * hardcode docker service names here: the app may live on a different
 * host/network than the node. If the advertised hostname doesn't resolve —
 * e.g. a bare identifier swallowed by a fake-IP DNS like mihomo — that is
 * a deployment DNS problem to fix at the resolver, not code to work
 * around.)
 */
function srsRtmpBase(flvBase: string): string {
  try {
    return `rtmp://${new URL(flvBase).hostname}:1935`
  } catch {
    return `rtmp://${flvBase}:1935`
  }
}

interface Variant {
  proc: ReturnType<typeof Bun.spawn>
  /** hosting node — DVR directory cleanup on teardown */
  nodeId: string
  lastWatchAt: number
}

const variants = new Map<string, Variant>()

/** Wait (bounded) until SRS mounts the twin's HTTP-FLV endpoint — i.e. the
 *  re-encoded stream is live and answerable. Unreachable FLV base just
 *  burns the timeout; the watch still answers (the frontend retries). */
async function waitForMount(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 500)
    try {
      const r = await fetch(url, { headers: { range: 'bytes=0-0' }, signal: ctrl.signal })
      ctrl.abort() // headers seen — never pull the endless stream
      if (r.status === 200 || r.status === 206) return
    } catch {
      /* not mounted yet / FLV base unreachable */
    } finally {
      clearTimeout(timer)
    }
    await new Promise((res) => setTimeout(res, 250))
  }
}

function teardown(stream: string, entry: Variant, notifyNode: boolean): void {
  if (variants.get(stream) !== entry) return
  variants.delete(stream)
  try {
    entry.proc.kill()
  } catch {
    /* already dead */
  }
  if (notifyNode) {
    // the twin's DVR files (records/clean-<stream>/) are junk — no-extension
    // rel path = directory sentinel in the node's delete handler
    sendRecordingDelete(entry.nodeId, [CLEAN_PREFIX + stream])
  }
}

/**
 * Returns the stream name a watch should be answered from: the clean twin
 * (starting it if needed), or the ORIGINAL stream when the concurrency cap
 * is hit (fallback = today's behavior). `flvBase` is the hosting node's
 * advertised SRS FLV base — the RTMP host is its hostname.
 */
export async function ensureCleanStream(stream: string, nodeId: string, flvBase: string): Promise<string> {
  const cleanName = CLEAN_PREFIX + stream
  const existing = variants.get(stream)
  if (existing) {
    existing.lastWatchAt = Date.now()
    return cleanName
  }
  if (variants.size >= MAX_CONCURRENT) {
    console.warn(`[clean] concurrency cap ${MAX_CONCURRENT} reached — answering from the original stream`)
    return stream
  }

  const rtmp = srsRtmpBase(flvBase)
  const proc = Bun.spawn(
    [
      env.ffmpegPath,
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      `${rtmp}/live/${stream}`,
      // strip B-frames (WebRTC cannot reference them) and guarantee a
      // decodable entry point every 2s regardless of the source frame rate
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-bf',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-c:a',
      'copy',
      '-f',
      'flv',
      `${rtmp}/live/${cleanName}`,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  )
  // drain stderr so the pipe never fills (a blocked pipe kills ffmpeg)
  void new Response(proc.stderr)
    .text()
    .then((tail) => {
      if (tail.trim()) console.warn(`[clean] ffmpeg(${stream}) stderr: ${tail.slice(-400)}`)
    })
    .catch(() => {})

  const entry: Variant = { proc, nodeId, lastWatchAt: Date.now() }
  variants.set(stream, entry)

  // source stream ended → ffmpeg EOFs → reap (and wipe the twin's DVR dir)
  void proc.exited.then(() => {
    console.log(`[clean] ffmpeg(${stream}) exited`)
    teardown(stream, entry, true)
  })

  await waitForMount(`${flvBase.replace(/\/+$/, '')}/live/${cleanName}.flv`)
  console.log(`[clean] twin ready: ${cleanName} (${variants.size} active)`)
  return cleanName
}

// idle reaper — WHEP answers are one-shot, so "last watch request" is the
// only viewer-liveness signal we have
setInterval(() => {
  const now = Date.now()
  for (const [stream, entry] of variants) {
    if (now - entry.lastWatchAt > IDLE_TTL_MS) {
      console.log(`[clean] reaping idle twin for ${stream}`)
      teardown(stream, entry, true)
    }
  }
}, REAP_INTERVAL_MS).unref?.()
