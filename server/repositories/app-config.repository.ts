/**
 * app_config table — generic key/value JSON store. Data access only.
 *
 * Two concerns live here, keyed apart so a secret (the SMTP password under
 * `mail`) never flows through the main config blob's GET:
 *   - key 'app_config' → all runtime config (limits/probe/record/registration/…)
 *   - key 'mail'       → SMTP/webhook sender config (held by mail-config.ts)
 */
import { eq } from 'drizzle-orm'
import { db } from '../database/db'
import { appConfig, type AppConfigRow } from '../database/schema'

const MAIN_KEY = 'app_config'

export const AppConfigRepository = {
  /** Read one JSON row by key. */
  findKey(key: string): AppConfigRow | undefined {
    return db.select().from(appConfig).where(eq(appConfig.key, key)).get()
  },
  /** Insert or update one JSON row by key (hot-reload write). */
  upsertKey(key: string, value: string): void {
    db.insert(appConfig)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } })
      .run()
  },

  /** The main runtime-config row (key = 'app_config'). */
  find(): AppConfigRow | undefined {
    return this.findKey(MAIN_KEY)
  },
  /** Insert or update the main config row (hot-reload write). */
  upsert(value: string): void {
    this.upsertKey(MAIN_KEY, value)
  },
}
