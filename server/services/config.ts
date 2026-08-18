/**
 * Config hot-reload. PATCH /api/config deep-merges a partial patch onto the
 * current config, re-validates the whole thing with zod, persists to app_config,
 * then applies the runtime effects:
 *   - invalidate the in-memory cache (next getConfig() sees the new value)
 *   - resize the probe semaphore to the new concurrency.probeMax
 *   - broadcast config:changed to admin clients
 * The recorder cap and per-probe limits are read fresh from getConfig() at use,
 * so they pick up the new value for new sessions / next probe without a push.
 */
import { ZodError } from 'zod'
import { createError } from 'h3'
import { AppConfigRepository } from '../repositories/app-config.repository'
import { appConfigSchema, type AppConfig } from '#shared/config'
import { getConfig, invalidateConfig } from '../utils/config-store'
import { setProbeConcurrency } from './stream-lifecycle'
import { emit } from '../utils/bus'
import { audit } from './audit'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], patch[key])
  }
  return out as T
}

export function getCurrentConfig(): AppConfig {
  return getConfig()
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const current = getConfig()
  let next: AppConfig
  try {
    next = appConfigSchema.parse(deepMerge(current, patch ?? {}))
  } catch (err) {
    if (err instanceof ZodError) {
      throw createError({ statusCode: 400, statusMessage: 'invalid config', data: err.issues })
    }
    throw err
  }

  const value = JSON.stringify(next)
  AppConfigRepository.upsert(value)

  invalidateConfig()
  setProbeConcurrency(next.concurrency.probeMax)
  emit('config:changed', next)
  audit('info', 'config', 'config updated', { detail: { changedKeys: Object.keys(patch ?? {}) } })
  return next
}
