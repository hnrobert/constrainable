/**
 * ffprobe-based stream inspection. Direct port of check_server.py parse_fps +
 * async_check_stream's probing logic (Bun.spawn instead of subprocess.run).
 */
import { env } from '../utils/env'
import { getConfig } from '../utils/config-store'
import { readStream, sleep } from '../utils/process'
import { buildFlvPullUrl } from '../utils/srs-url'

export interface ProbeResult {
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
}

/**
 * Port of parse_fps: convert an ffprobe fraction like "30000/1001" or "0/0"
 * to a float. Returns null when missing, malformed, or denominator is 0.
 */
export function parseFps(fraction?: string | null): number | null {
  if (!fraction || !fraction.includes('/')) return null
  const [numStr, denStr] = fraction.split('/')
  const num = Number(numStr)
  const den = Number(denStr)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return num / den
}

/** One ffprobe attempt. Returns null on any failure (caller retries). */
async function probeOnce(target: string, timeoutMs: number): Promise<ProbeResult | null> {
  const cmd = [
    env.ffprobePath,
    '-v',
    'error',
    // Default analysis budgets hang for many seconds on low-frame-rate live
    // streams (1 FPS): codec info sits in the first keyframe + sequence
    // headers, so a tiny probesize/analyzeduration answers instantly.
    '-probesize',
    '65536',
    '-analyzeduration',
    '2000000',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate,r_frame_rate,bit_rate',
    '-show_entries',
    'format=bit_rate',
    '-of',
    'json',
    target,
  ]
  const proc = Bun.spawn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const code = await Promise.race([proc.exited, sleep(timeoutMs).then(() => null)])
  if (code === null) {
    try {
      proc.kill()
    } catch {
      // ignore
    }
    return null
  }
  if (code !== 0) return null
  let data: any
  try {
    data = JSON.parse(await readStream(proc.stdout as ReadableStream<Uint8Array>))
  } catch {
    return null
  }
  const s = data?.streams?.[0]
  if (!s) return null
  const width = Number(s.width) || 0
  const height = Number(s.height) || 0
  const fps = parseFps(s.avg_frame_rate) ?? parseFps(s.r_frame_rate) ?? 0
  const videoBitrateKbps = Math.floor((Number(s.bit_rate) || Number(data?.format?.bit_rate) || 0) / 1000)
  return { width, height, fps, videoBitrateKbps }
}

/**
 * Probe with retries (matches async_check_stream's retry loop).
 * Call through a probeSemaphore for concurrency control.
 */
export async function probeStream(rtmpUrl: string): Promise<ProbeResult | null> {
  const { retries, timeoutMs, retryIntervalMs } = getConfig().probe
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await probeOnce(rtmpUrl, timeoutMs)
    if (result) return result
    if (attempt < retries) await sleep(retryIntervalMs)
  }
  return null
}

/** Convenience: build the RTMP pull URL and probe in one call. */
export function probeAppStream(app: string, stream: string, _vhost?: string): Promise<ProbeResult | null> {
  return probeStream(buildFlvPullUrl(stream))
}
