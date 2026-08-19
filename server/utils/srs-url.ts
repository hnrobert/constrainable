import { env } from './env'
import { getHostingNode } from '../services/media-node-registry'
import { signMediaUrl } from './signed-url'

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
 * Playback URLs for a live stream.
 *
 * FLV — two paths depending on the hosting node:
 *  - Multi-node (node advertises PUBLIC_DOMAIN): a SIGNED ABSOLUTE URL on the
 *    node's own play endpoint (`http://<domain>:<port>/live/<s>.flv?exp&sig`). The
 *    browser pulls video DIRECTLY from the node — playback bandwidth never
 *    transits the control plane. Each pull is authorized by the node via the
 *    `play:auth` Socket.IO ack (the app verifies the signature it minted).
 *  - Single-server default (no PUBLIC_DOMAIN): the same-origin proxy at
 *    /api/streams/live/<stream> — the app pulls from the internal SRS.
 *
 * WHEP (WebRTC): only the SDP signaling is proxied same-origin
 * (/api/streams/whep/<stream>); the media flows browser↔SRS peer-to-peer.
 */
export function buildPlaybackUrls(streamName: string): PlaybackUrls {
  const path = `/live/${encodeURIComponent(streamName)}.flv`
  const node = getHostingNode(streamName)
  const flv = node?.publicOrigin ? signMediaUrl(node.publicOrigin, path) : `/api/streams/live/${encodeURIComponent(streamName)}`
  return {
    flv,
    whep: `/api/streams/whep/${encodeURIComponent(streamName)}`,
  }
}

