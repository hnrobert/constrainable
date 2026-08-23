/**
 * Centralized env reading. All server modules read config from here,
 * never directly from process.env. (Mirrors kaleidodanmu lib/env.ts.)
 */
/**
 * Parse ICE servers for browser WebRTC (admin viewers) from the ICE_SERVERS
 * env. Accepts either a JSON array ([{urls, username?, credential?}] — full
 * RTCIceServer shape, TURN credentials included) or a comma-separated URL
 * list (stun:/turn:). Malformed input → [] + a warning; the default is []
 * because SRS is ICE-lite with a public host candidate — browsers need no
 * STUN to reach it. TURN (coturn) can be added later env-only.
 */
export type { IceServer } from '#shared/rtmp'

import type { IceServer } from '#shared/rtmp'

export function parseIceServers(raw: string): IceServer[] {
  const text = raw.trim()
  if (!text) return []
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) throw new Error('not an array')
      return parsed.filter((e): e is IceServer => typeof e?.urls === 'string' && e.urls !== '')
    } catch (err) {
      console.warn(`[env] ICE_SERVERS is not a valid JSON array, ignoring: ${err}`)
      return []
    }
  }
  const urls = text
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  if (urls.length === 0) return []
  // turn:user:pass@host:port → turn:host:port + credentials (RFC-ish shorthand)
  return urls.map((u) => {
    const m = u.match(/^(turn[s]?):([^:]+):([^@]+)@(.+)$/)
    if (m) return { urls: `${m[1]}:${m[4]}`, username: m[2], credential: m[3] } as IceServer
    return { urls: u } as IceServer
  })
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',

  /** SQLite file path */
  dbPath: process.env.DB_PATH || './data/app.db',
  /** Recordings root dir */
  recordDir: process.env.RECORD_DIR || './records',

  /** Session signing secret (legacy HMAC; kept for any fallback reads). */
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  /** JWT signing secret (HS256). Falls back to the legacy session secret. */
  jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',

  /** AES-256-GCM key for at-rest secrets (RTMP authmod verifier, etc.). */
  verifierSecret: process.env.AUTHMOD_VERIFIER_SECRET || 'dev-insecure-secret-change-me',
  /**
   * Shared secret for media-node socket connections + internal endpoints.
   * Empty string = NO auth (any media node can connect). Set in production.
   */
  mediaNodeAuthToken: process.env.MEDIA_NODE_AUTH_TOKEN || '',

  /** SRS HTTP API base (LOCAL sessions only — media-node sessions kick via socket) */
  srsApiBase: process.env.SRS_API_BASE || 'http://127.0.0.1:1985/api/v1',
  /**
   * LOCAL SRS HTTP-FLV fallback for the playback proxy. Sessions on a media
   * node route to that node's advertised base instead (see
   * media-node-registry.resolveFlvBase) — this only serves streams this
   * backend hosts itself (dev / app-managed SRS).
   */
  srsFlvBase: process.env.SRS_FLV_BASE || 'http://127.0.0.1:38081', // SRS http_server (38081; the node play entry is 38080)
  /** SRS RTMP host (server-to-server, for ffprobe/ffmpeg pull) */
  srsRtmpHost: process.env.SRS_RTMP_HOST || '127.0.0.1',
  /** Browser-facing SRS API port (WHEP playback URLs) */
  srsApiPort: Number(process.env.SRS_API_PORT || '1985'),

  /** ffmpeg / ffprobe binaries */
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',

  /**
   * Frontend origins allowed to make credentialed cross-origin API calls
   * (split deployment: static frontend on a CDN + API on its own origin —
   * pairs with the frontend's API_ORIGIN). Empty = same-origin only.
   * Also switches the session cookie to SameSite=None; Secure.
   */
  /**
   * ICE servers for admin WebRTC viewers (STUN now; TURN later). Parsed from
   * ICE_SERVERS — see parseIceServers below for the accepted formats.
   */
  iceServers: parseIceServers(process.env.ICE_SERVERS || ''),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const

export type Env = typeof env
