import { env } from './env'
import type { IceServer } from '#shared/rtmp'
import { getHostingNode } from '../services/media-node-registry'

/**
 * The server-to-SRS pull address for the recorder and the monitor probe, as an
 * HTTP-FLV URL. RTMP pulls are NOT used: SRS's RTMP-play consumer starves on
 * low-frame-rate streams (its merged-write queue stops delivering for ~1fps
 * content), while the HTTP-FLV path serves the same stream fine — verified
 * against live 1fps pushes on both paths. `@` etc. are already sanitized out of
 * stream names by the gateway, and encodeURI keeps the path literal for ffmpeg.
 *
 * `base` overrides the local SRS default (env.srsFlvBase) — pass the hosting
 * media node's advertised FLV base for remote sessions (see
 * media-node-registry.resolveFlvBase).
 */
export function buildFlvPullUrl(stream: string, base: string = env.srsFlvBase): string {
  return `${base}/live/${encodeURI(stream)}.flv`
}

/** Legacy RTMP pull address (kept for tooling that must speak RTMP). */
export function buildRtmpUrl(app: string, stream: string, vhost?: string): string {
  let url = `rtmp://${env.srsRtmpHost}/${encodeURI(app)}/${encodeURI(stream)}`
  if (vhost && vhost !== '__defaultVhost__') {
    url += `?vhost=${encodeURIComponent(vhost)}`
  }
  return url
}

export interface PlaybackUrls {
  whep: string
  /** ICE servers for the browser's WebRTC (WHEP) connection — env-driven,
   *  empty when SRS's public candidate is directly reachable (ICE-lite) */
  iceServers: IceServer[]
}

/**
 * Playback for a live stream is WebRTC ONLY: the SDP signaling is proxied
 * same-origin (/api/streams/whep/<stream>, admin-gated — media can never
 * start without an authenticated session); the MEDIA itself flows directly
 * browser↔the hosting node's SRS over UDP. No FLV path exists for browsers.
 */
export function buildPlaybackUrls(streamName: string): PlaybackUrls {
  return {
    whep: `/api/streams/whep/${encodeURIComponent(streamName)}`,
    iceServers: env.iceServers,
  }
}

