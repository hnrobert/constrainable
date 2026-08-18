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

export function getConfig(): AppConfig {
  if (_cache) return _cache
  try {
    const row = AppConfigRepository.find()
    _cache = appConfigSchema.parse(row ? JSON.parse(row.value) : {})
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
    const o = JSON.parse(raw) as Partial<Limits>
    return {
      maxWidth: o.maxWidth ?? g.maxWidth,
      maxHeight: o.maxHeight ?? g.maxHeight,
      maxFps: o.maxFps ?? g.maxFps,
      maxBitrateKbps: o.maxBitrateKbps ?? g.maxBitrateKbps,
    }
  } catch {
    return g
  }
}
