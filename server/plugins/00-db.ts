/**
 * Bootstrap plugin: sync schema.ts → DB (drizzle-kit push) before any request is
 * served. Runs once at Nitro startup. No first-boot seeding — admins, events,
 * and config are created through the UI/API. Defaults for config come from the
 * zod schema (see shared/config.ts + utils/config-store.ts).
 */
import { ensureDbReady } from '../database/db'

export default defineNitroPlugin(async () => {
  try {
    await ensureDbReady()
    console.log('[db] ready')
  } catch (err) {
    console.error('[db] bootstrap failed:', err)
    throw err
  }
})
