/**
 * Read-through config cache backed by the `app_config` row (via
 * AppConfigRepository). getConfig() is safe to call before any row exists: a
 * missing row or parse error falls back to the zod defaults.
 *
 * This is the only in-memory cache for config; services read through it so the
 * hot-reload invalidate() flips the whole process onto the new value at once.
 */
import { AppConfigRepository } from '../repositories/app-config.repository'
import { appConfigSchema, type AppConfig, type Limits } from '#shared/config'

let _cache: AppConfig | null = null

/** Map pre-rename JSON onto the current schema: the video cap used to be
 *  `maxBitrateKbps` (limits + per-event overrides) — rename in place when the
 *  new key is absent so customized values survive the upgrade. */
function migrateLegacyLimits(raw: unknown): unknown {
  const o = raw as Record<string, unknown> & { limits?: Record<string, unknown> }
  if (o?.limits && 'maxBitrateKbps' in o.limits && !('maxVideoBitrateKbps' in o.limits)) {
    o.limits.maxVideoBitrateKbps = o.limits.maxBitrateKbps
    delete o.limits.maxBitrateKbps
  }
  return o
}

export function getConfig(): AppConfig {
  if (_cache) return _cache
  try {
    const row = AppConfigRepository.find()
    _cache = appConfigSchema.parse(row ? migrateLegacyLimits(JSON.parse(row.value)) : {})
  } catch (err) {
    console.error('[config] load failed, using defaults:', err)
    _cache = appConfigSchema.parse({})
  }
  return _cache
}

/** Drop the cache so the next getConfig() re-reads the DB (hot-reload). */
export function invalidateConfig(): void {
  _cache = null
}

/** Merge global limits with an event's override (override wins where set). */
export function getLimitsFor(event?: { limitsOverride: string | null } | null): Limits {
  const g = getConfig().limits
  const raw = event?.limitsOverride
  if (!raw) return g
  try {
    // pre-rename rows stored the video cap as maxBitrateKbps — accept both
    const o = JSON.parse(raw) as Partial<Limits> & { maxBitrateKbps?: number }
    return {
      maxWidth: o.maxWidth ?? g.maxWidth,
      maxHeight: o.maxHeight ?? g.maxHeight,
      maxFps: o.maxFps ?? g.maxFps,
      maxVideoBitrateKbps: o.maxVideoBitrateKbps ?? o.maxBitrateKbps ?? g.maxVideoBitrateKbps,
      maxAudioBitrateKbps: o.maxAudioBitrateKbps ?? g.maxAudioBitrateKbps,
    }
  } catch {
    return g
  }
}
