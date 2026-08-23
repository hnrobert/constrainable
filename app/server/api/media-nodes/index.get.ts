/**
 * Admin: list currently-registered media nodes with quota + assignment state.
 * The nodes page consumes this for its initial render; live updates arrive as
 * `nodes:changed` over Socket.IO (see services/media-node-snapshot.ts).
 */
import { nodesSnapshot } from '../../services/media-node-snapshot'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return nodesSnapshot()
})
