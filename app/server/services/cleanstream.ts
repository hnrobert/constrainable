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
/** in-flight spawns, keyed by stream — concurrent watch requests share ONE twin */
const spawning = new Map<string, Promise<string>>()

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
  // Only the CURRENT map entry is unregistered — but the kill and the junk
  // wipe always run for THIS entry. Skipping them on a stale entry leaks two
  // ways: a twin replaced by a racing spawn keeps transcoding forever, and a
  // twin whose reap already removed the map entry never sends its cleanup
  // sentinel (verified live: records/live/clean-<user>/ accumulated a 21MB
  // .flv exactly this way). The sentinel is idempotent — wiping the
  // directory while a replacement twin writes into it just means SRS's
  // finalize-rename misses and the junk never lands.
  if (variants.get(stream) === entry) variants.delete(stream)
  try {
    entry.proc.kill()
  } catch {
    /* already dead */
  }
  if (notifyNode) {
    // the twin's DVR files (records/live/clean-<stream>/) are junk —
    // no-extension rel path = directory sentinel in the node's delete handler
    sendRecordingDelete(entry.nodeId, ['live/' + CLEAN_PREFIX + stream])
  }
}

/**
 * Returns the stream name a watch should be answered from: the clean twin
 * (starting it if needed), or the ORIGINAL stream when the concurrency cap
 * is hit (fallback = today's behavior). `flvBase` is the hosting node's
 * advertised SRS FLV base (RTMP host = its hostname); `eventKey` is the
 * event slug of the live session — the relay publishes the ORIGINAL under
 * SRS app=<eventKey> (DVR → /records/<eventKey>/<user>/), so the twin must
 * PULL from that app. The twin itself is PUSHED to the plain "live" app —
 * watch-only junk at /records/live/clean-<user>/, which the node wipes via
 * the directory-sentinel delete.
 */
export async function ensureCleanStream(
  stream: string,
  nodeId: string,
  flvBase: string,
  eventKey: string,
): Promise<string> {
  const cleanName = CLEAN_PREFIX + stream
  const existing = variants.get(stream)
  if (existing) {
    existing.lastWatchAt = Date.now()
    return cleanName
  }
  // A spawn already in flight for this stream? Share it — two watch requests
  // racing through the "no existing twin" check would otherwise BOTH spawn,
  // and the entry the second spawn overwrites is never killed (orphaned
  // transcoder, forever pulling and pushing).
  const inflight = spawning.get(stream)
  if (inflight) return inflight
  if (variants.size >= MAX_CONCURRENT) {
    console.warn(`[clean] concurrency cap ${MAX_CONCURRENT} reached — answering from the original stream`)
    return stream
  }

  const p = startTwin(stream, cleanName, nodeId, flvBase, eventKey)
  spawning.set(stream, p)
  try {
    return await p
  } finally {
    spawning.delete(stream)
  }
}

async function startTwin(
  stream: string,
  cleanName: string,
  nodeId: string,
  flvBase: string,
  eventKey: string,
): Promise<string> {
  // Previous watch cycle's junk: the teardown sentinels can LOSE the race
  // with SRS's DVR finalize (the .tmp→.flv rename re-creates the directory
  // after our delete — verified live). At spawn time the previous twin has
  // been dead for at least the idle TTL, so its finalize has certainly
  // landed and this wipe deterministically wins.
  sendRecordingDelete(nodeId, ['live/' + cleanName])

  const rtmp = srsRtmpBase(flvBase)
  const proc = Bun.spawn(
    [
      env.ffmpegPath,
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      `${rtmp}/${eventKey}/${stream}`,
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

  // Source stream ended → ffmpeg EOFs → reap (and wipe the twin's DVR dir).
  // The wipe is DELAYED a beat: SRS finalizes the twin's DVR (rename
  // .tmp → .flv) only after it sees the push connection drop — a sentinel
  // that beats the finalize deletes the directory and SRS's rename then
  // RE-CREATES the junk (observed live). Two seconds comfortably covers the
  // finalize on an idle stream.
  void proc.exited.then(() => {
    console.log(`[clean] ffmpeg(${stream}) exited`)
    setTimeout(() => teardown(stream, entry, true), 2_000).unref?.()
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
