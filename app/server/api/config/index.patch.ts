/**
 * Hot-reload the runtime config. Body is a PARTIAL config (deep-merged);
 * unknown keys are dropped by the zod schema. Validation errors → 400.
 */
import { updateConfig } from '../../services/config'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event)
  return updateConfig(body ?? {})
})
