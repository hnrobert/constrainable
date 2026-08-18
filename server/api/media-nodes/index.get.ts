/**
 * Admin: list currently-registered media nodes (Go backends). Shows origin,
 * hostname, version, active stream count, and connection time.
 */
import { listNodes } from '../../services/media-node-registry'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listNodes()
})
