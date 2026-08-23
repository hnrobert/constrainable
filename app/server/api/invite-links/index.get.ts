/** List all invite links (admin-only). */
import { listInvites } from '../../services/invites'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listInvites()
})
