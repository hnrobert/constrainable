/** List all users with their group memberships (admin-only). */
import { listUsersWithGroups } from '../../services/groups'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listUsersWithGroups()
})
