/**
 * Ingest node list for the USER-facing /nodes page (any logged-in user — the
 * admin matrix stays at /api/media-nodes). One row per REGISTERED node: OBS
 * address, load (assigned / auto-assign cap), whether it's the caller's
 * current pin, and the STUN probe port for browser-side ICE latency probing
 * (0 = old firmware without the responder).
 */
import { listNodes } from '../../services/media-node-registry'
import { NodeSettingsRepository } from '../../repositories/node-settings.repository'
import { UsersRepository } from '../../repositories/users.repository'
import { obsServerUrl } from '#shared/rtmp'

export default defineEventHandler((event) => {
  const auth = requireUser(event)
  const me = UsersRepository.findById(auth.userId)
  return listNodes().map((n) => ({
    nodeId: n.nodeId,
    rtmpUrl: n.publicRtmpAuthority ? obsServerUrl(n.publicRtmpAuthority) : null,
    assigned: NodeSettingsRepository.assignedCount(n.nodeId),
    maxUsers: NodeSettingsRepository.getMaxUsers(n.nodeId),
    /** >0 = firmware runs the STUN probe responder → browser-true ICE probe */
    probePort: n.probePort ?? 0,
    isMine: me?.nodeId === n.nodeId,
  }))
})
