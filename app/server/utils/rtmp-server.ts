/**
 * RTMP ingest URL for guide payloads. Host priority: the PUBLIC_HOST override,
 * else the host this request came in on (mirrors useObsConfig's browse-origin
 * fallback — without it the default deployment would render `rtmp:///live`).
 * The standard port 1935 is omitted; remapped ports live in the node's
 * PUBLIC_MEDIA_NODE_RTMP_PORT (per-node). Per-viewer node
 * refinement (assigned node authority) stays client-side in useObsConfig, so
 * the payload stays identical for every viewer of an event.
 */
import type { H3Event } from 'h3'
import { obsServerUrl } from '#shared/rtmp'

export function guideRtmpServer(h3Event: H3Event): string {
  const cfg = useRuntimeConfig(h3Event)
  const override = String(cfg.public.srsPublicHost || '').trim()
  const host = (override || getRequestHost(h3Event, { xForwardedHost: true }) || '').split(':')[0] ?? ''
  // standard port 1935 (omitted) — remapped ports belong in the node's
  // PUBLIC_MEDIA_NODE_RTMP_PORT, which the client-side assignment overrides with
  return obsServerUrl(host)
}
