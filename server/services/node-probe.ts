/**
 * Shared derivation for the browser ICE latency probe (see the node's
 * node/probe.go STUN responder). The browser validates the responder's STUN
 * response MESSAGE-INTEGRITY against the ICE password in the answer SDP we
 * mint (/api/nodes/probe-ice), so both sides derive the SAME value from the
 * node auth token they already share:
 *   base64(hmac-sha256(MEDIA_NODE_AUTH_TOKEN, "ice-probe"))[:22]
 * Keep byte-identical to the Go side.
 */
import { createHmac } from 'node:crypto'
import { env } from '../utils/env'

export const PROBE_UFRAG = 'probe'

export function probeIcePwd(): string {
  return createHmac('sha256', env.mediaNodeAuthToken).update('ice-probe').digest('base64').slice(0, 22)
}
