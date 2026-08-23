/** Read the full runtime config (admin-only). */
import { getCurrentConfig } from '../../services/config'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return getCurrentConfig()
})
