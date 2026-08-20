/**
 * Mint the ANSWER SDP for a browser-side ICE latency probe against one node's
 * STUN responder (node/probe.go, UDP PROBE_UDP_PORT — published in compose).
 * The browser POSTs its data-channel-only offer; we answer with:
 *   - ice-ufrag/pwd derived from the shared node auth token (the responder
 *     validates nothing but answers with MI computed over the same pwd, which
 *     is what makes the browser's ICE agent ACCEPT the response)
 *   - one host candidate: the node's public authority host + probePort
 * The DTLS fingerprint is a placeholder — DTLS never completes (there is no
 * peer); the browser reads the candidate-pair RTT from getStats() long before
 * the connection gives up and the page closes the PC.
 */
import { createError } from 'h3'
import { getNode } from '../../../services/media-node-registry'
import { probeIcePwd, PROBE_UFRAG } from '../../../services/node-probe'

// sha-256 fingerprint of 32 zero bytes — structurally valid, never verified
const DUMMY_FP = Array.from({ length: 32 }, () => '00').join(':').toUpperCase()

export default defineEventHandler(async (event) => {
  requireUser(event)
  const nodeId = String(getRouterParam(event, 'nodeId') ?? '')
  const node = getNode(nodeId)
  if (!node) throw createError({ statusCode: 404, statusMessage: 'node not found' })
  if (!node.probePort) {
    throw createError({
      statusCode: 501,
      statusMessage: 'node firmware has no probe port — falling back to server-side probe',
    })
  }
  const host = node.publicRtmpAuthority.split(':')[0]
  if (!host) {
    throw createError({ statusCode: 501, statusMessage: 'node has no public authority — server-side probe only' })
  }

  await readRawBody(event) // offer consumed by the page; answer is canonical

  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=latency-probe',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=ice-options:trickle',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    `a=ice-ufrag:${PROBE_UFRAG}`,
    `a=ice-pwd:${probeIcePwd()}`,
    `a=fingerprint:sha-256 ${DUMMY_FP}`,
    'a=setup:active',
    'a=sctp-port:5000',
    `a=candidate:1 1 udp 2130706431 ${host} ${node.probePort} typ host generation 0`,
    'a=end-of-candidates',
  ].join('\r\n')

  setHeader(event, 'content-type', 'application/sdp')
  setHeader(event, 'cache-control', 'no-store')
  return sdp
})
