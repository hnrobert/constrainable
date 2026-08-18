/** List all groups with member counts (admin-only). */
import { listGroups } from '../../services/groups'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listGroups()
})
