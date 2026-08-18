/**
 * Same-origin WHEP (WebRTC) signaling proxy — the SDP exchange only. The
 * browser POSTs its offer here; we forward it to the hosting SRS's
 * /rtc/v1/whep/ endpoint (reached over the internal network, same host as the
 * FLV base) and return the answer. Same-origin keeps JWT auth + no CORS, and
 * removes any need for SRS's API port to be browser-visible — only the MEDIA
 * (ICE/UDP 8000) still flows browser↔SRS directly, which is the point of
 * WebRTC. Admin-only, like the FLV proxy.
 */
import { createError, getRouterParam } from 'h3'
import { env } from '../../../utils/env'
import { resolveFlvBase } from '../../../services/media-node-registry'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const stream = decodeURIComponent(String(getRouterParam(event, 'stream') ?? '')).trim()
  if (!stream || stream.includes('/')) {
    throw createError({ statusCode: 400, statusMessage: 'stream is required' })
  }
  const offer = await readRawBody(event)
  if (!offer) {
    throw createError({ statusCode: 400, statusMessage: 'SDP offer body is required' })
  }

  // SRS serves both the FLV remux and the HTTP API from the same host — swap
  // the FLV base's port for the API port.
  const target = new URL(resolveFlvBase(stream))
  target.port = String(env.srsApiPort)
  target.pathname = '/rtc/v1/whep/'
  target.search = `?app=live&stream=${encodeURIComponent(stream)}`

  let resp: Response
  try {
    resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offer,
    })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'WHEP endpoint not reachable (stream live?)' })
  }
  if (!resp.ok) {
    throw createError({ statusCode: 502, statusMessage: `SRS WHEP responded ${resp.status}` })
  }

  setHeader(event, 'content-type', 'application/sdp')
  setHeader(event, 'cache-control', 'no-store')
  return await resp.text()
})
