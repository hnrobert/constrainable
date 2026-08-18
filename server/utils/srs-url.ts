import { env } from './env'

/**
 * The server-to-SRS pull address for the recorder and the monitor probe, as an
 * HTTP-FLV URL. RTMP pulls are NOT used: SRS's RTMP-play consumer starves on
 * low-frame-rate streams (its merged-write queue stops delivering for ~1fps
 * content), while the HTTP-FLV path serves the same stream fine — verified
 * against live 1fps pushes on both paths. `@` etc. are already sanitized out of
 * stream names by the gateway, and encodeURI keeps the path literal for ffmpeg.
 */
export function buildFlvPullUrl(stream: string): string {
  return `${env.srsFlvBase}/live/${encodeURI(stream)}.flv`
}

/** Legacy RTMP pull address (kept for tooling that must speak RTMP). */
export function buildRtmpUrl(app: string, stream: string, vhost?: string): string {
  let url = `rtmp://${env.srsRtmpHost}/${encodeURI(app)}/${encodeURI(stream)}`
  if (vhost && vhost !== '__defaultVhost__') {
    url += `?vhost=${encodeURIComponent(vhost)}`
  }
  return url
}

/** SRS app name used for all live streams (matches the OBS /live mount). */
const LIVE_APP = 'live'

export interface PlaybackUrls {
  flv: string
  whep: string
}

/**
 * Playback URLs for a live stream.
 *
 * FLV: a RELATIVE same-origin URL — the app proxies SRS's HTTP-FLV remux at
 * /api/streams/live/<stream> (see server/api/streams/live/[stream].get.ts), so
 * playback needs no CORS and works from any machine that can reach the app,
 * regardless of SRS's host/ports.
 *
 * WHEP (WebRTC): the browser must talk to SRS directly (media is peer-to-peer;
 * only the SDP signaling could be proxied), so this stays an absolute URL on
 * the browser-visible host.
 */
export function buildPlaybackUrls(streamName: string): PlaybackUrls {
  return {
    flv: `/api/streams/live/${encodeURIComponent(streamName)}`,
    whep: `http://${env.publicHost}:${env.srsApiPort}/rtc/v1/whep/?app=${LIVE_APP}&stream=${encodeURIComponent(streamName)}`,
  }
}

