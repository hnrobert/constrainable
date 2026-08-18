/**
 * Same-origin FLV playback proxy. Admin browsers pull live streams through the
 * backend at /api/streams/live/<streamName> — same origin as the dashboard, so
 * JWT auth works, no CORS, and no dependency on media-node SRS ports being
 * reachable from the viewer's machine.
 *
 * Routing: currently proxies from the local SRS (env.srsFlvBase). Multi-node
 * routing (proxy from the hosting media-node's SRS) will use the stream →
 * nodeId mapping tracked by media-node events — the interface is ready below.
 *
 * Admin-only. WebRTC (WHEP) is NOT proxied — its media flows peer-to-peer.
 */
import { createError, getRouterParam, sendStream } from 'h3'
import { Readable } from 'node:stream'
import { env } from '../../../utils/env'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const stream = decodeURIComponent(String(getRouterParam(event, 'stream') ?? '')).trim()
  if (!stream || stream.includes('/')) {
    throw createError({ statusCode: 400, statusMessage: 'stream is required' })
  }

  // `@` (account emails) is a legal path character and this SRS version hangs
  // on the %40 form — encodeURI keeps it verbatim while covering truly unsafe
  // characters.
  const upstreamUrl = `${env.srsFlvBase}/live/${encodeURI(stream)}.flv`
  const ac = new AbortController()
  event.node.req.on('close', () => ac.abort()) // viewer left → stop pulling from SRS

  let resp: Response
  try {
    resp = await fetch(upstreamUrl, { signal: ac.signal })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'stream not reachable (is it live?)' })
  }
  if (!resp.ok || !resp.body) {
    throw createError({ statusCode: 502, statusMessage: `SRS responded ${resp.status}` })
  }

  setHeader(event, 'content-type', 'video/x-flv')
  setHeader(event, 'cache-control', 'no-store')
  // fetch's DOM ReadableStream vs node:stream/web's type — same runtime shape.
  return sendStream(event, Readable.fromWeb(resp.body as unknown as Parameters<typeof Readable.fromWeb>[0]))
})
