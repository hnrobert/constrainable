/**
 * Centralized env reading. All server modules read config from here,
 * never directly from process.env. (Mirrors kaleidodanmu lib/env.ts.)
 */
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

  /** SRS HTTP API base (server-to-server) */
  srsApiBase: process.env.SRS_API_BASE || 'http://127.0.0.1:1985/api/v1',
  /** SRS HTTP-FLV base (server-to-server, for the same-origin playback proxy) */
  srsFlvBase: process.env.SRS_FLV_BASE || 'http://127.0.0.1:8080',
  /** SRS RTMP host (server-to-server, for ffprobe/ffmpeg pull) */
  srsRtmpHost: process.env.SRS_RTMP_HOST || '127.0.0.1',
  /** Browser-facing SRS ports (for viewer playback URLs) */
  srsFlvPort: Number(process.env.SRS_FLV_PORT || '8080'),
  srsApiPort: Number(process.env.SRS_API_PORT || '1985'),

  /** ffmpeg / ffprobe binaries */
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',

  /** Browser-visible SRS host for playback URLs (LAN/public IP) */
  publicHost: process.env.PUBLIC_HOST || '127.0.0.1',
} as const

export type Env = typeof env
