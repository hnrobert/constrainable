import { env } from './env'

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
  flv: string
  whep: string
}

/**
 * Playback URLs for a live stream — BOTH same-origin relative paths, so no
 * SRS host/port is ever browser-visible and no PUBLIC_HOST-style env is
 * needed.
 *
 * FLV: the app proxies SRS's HTTP-FLV remux at /api/streams/live/<stream> (see
 * server/api/streams/live/[stream].get.ts) — works from any machine that can
 * reach the app.
 *
 * WHEP (WebRTC): only the SDP signaling is proxied (/api/streams/whep/<stream>
 * → the hosting SRS's API over the internal network); the media itself still
 * flows browser↔SRS peer-to-peer via ICE/UDP.
 */
export function buildPlaybackUrls(streamName: string): PlaybackUrls {
  return {
    flv: `/api/streams/live/${encodeURIComponent(streamName)}`,
    whep: `/api/streams/whep/${encodeURIComponent(streamName)}`,
  }
}

