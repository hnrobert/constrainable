import { z } from 'zod'

/**
 * The full application config. Stored as one JSON row (`key = 'app_config'`)
 * and the source of truth for all runtime behavior — editable in the UI with
 * hot-reload. Defaults come from the zod schema below (appConfigSchema.parse({})).
 *
 * Each nested object schema is declared separately so its default can be
 * derived once via `.parse({})`; the parent field then `.default()`s to that
 * fully-populated object. This lets `appConfigSchema.parse({})` and partial
 * inputs (e.g. a PATCH missing some sub-keys) both resolve correctly.
 */

const srsSchema = z.object({
  apiBase: z.string().default('http://127.0.0.1:1985/api/v1'),
  rtmpHost: z.string().default('127.0.0.1'),
})

const probeSchema = z.object({
  /** wait for the stream to stabilize before first probe */
  waitMs: z.number().int().min(0).default(3000),
  retries: z.number().int().min(0).default(3),
  timeoutMs: z.number().int().min(500).default(10000),
  retryIntervalMs: z.number().int().min(0).default(2000),
  /** interval between re-probes of an active stream */
  pollIntervalMs: z.number().int().min(1000).default(5000),
})

const limitsSchema = z.object({
  maxWidth: z.number().int().min(0).default(1920),
  maxHeight: z.number().int().min(0).default(1080),
  maxFps: z.number().min(0).default(30),
  maxBitrateKbps: z.number().int().min(0).default(4000),
})

const recordSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('./records'),
  /** max concurrent ffmpeg recorder processes */
  maxConcurrency: z.number().int().min(1).default(16),
  /** auto-delete recordings older than N days (0 = keep forever) */
  retentionDays: z.number().int().min(0).default(7),
  /** grace period for ffmpeg FLV→MP4 remux before force-killing */
  remuxTimeoutMs: z.number().int().min(1000).default(30000),
})

const concurrencySchema = z.object({
  /** max concurrent ffprobe checks */
  probeMax: z.number().int().min(1).default(8),
})

/**
 * Registration email restrictions (mirrors unnc-freshmen-verifier-gateway).
 *   - emailWhitelist: when enabled, a registration email must match at least one
 *     picomatch glob (e.g. `*@nottingham.edu.cn`). Empty patterns + enabled =
 *     no-op (allow all), so an admin can't lock the app out. The very first
 *     registration (super-admin bootstrap) ALWAYS bypasses this.
 *   - disallowedPatterns: substrings (case-insensitive) that are never accepted
 *     — institutional mailing-list accounts like `student` / `staff`. Default
 *     mirrors the gateway; editable to suit your org.
 */
const emailWhitelistSchema = z.object({
  enabled: z.boolean().default(false),
  patterns: z.array(z.string()).default([]),
})

const registrationSchema = z.object({
  emailWhitelist: emailWhitelistSchema.default(emailWhitelistSchema.parse({})),
  disallowedPatterns: z.array(z.string()).default(['student', 'staff']),
  /**
   * Admin-authored notice rendered as a panel atop the registration form
   * (plain text, whitespace preserved; '' = panel hidden). Served publicly
   * via /api/auth/bootstrap so the pre-login page can show it.
   */
  notice: z.string().default(''),
})

export const appConfigSchema = z.object({
  srs: srsSchema.default(srsSchema.parse({})),
  probe: probeSchema.default(probeSchema.parse({})),
  limits: limitsSchema.default(limitsSchema.parse({})),
  record: recordSchema.default(recordSchema.parse({})),
  concurrency: concurrencySchema.default(concurrencySchema.parse({})),
  registration: registrationSchema.default(registrationSchema.parse({})),
})

export type AppConfig = z.infer<typeof appConfigSchema>
export type Limits = z.infer<typeof limitsSchema>
export type Registration = z.infer<typeof registrationSchema>

/** Per-event limits override (all optional; null/undefined = inherit global). */
export const limitsOverrideSchema = z.object({
  maxWidth: z.number().int().min(0).nullish(),
  maxHeight: z.number().int().min(0).nullish(),
  maxFps: z.number().min(0).nullish(),
  maxBitrateKbps: z.number().int().min(0).nullish(),
})

export type LimitsOverride = z.infer<typeof limitsOverrideSchema>
