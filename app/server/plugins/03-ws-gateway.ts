/**
 * Bun-native WebSocket gateway — the app's ONLY public listener in
 * production ("front" mode):
 *
 *   :PORT (31954)  Bun.serve ─┬─ /ws/media-node  protobuf control (Go nodes)
 *                             ├─ /ws/admin       JSON dashboard realtime
 *                             └─ everything else → fetch → 127.0.0.1:INTERNAL
 *                                                  (Nitro node:http)
 *
 * This removes the separate gateway port entirely: browsers, LAN-direct
 * nodes, and reverse-proxied remote nodes all speak WS on the SAME origin
 * and port as the app (the edge just needs to pass WebSocket upgrades,
 * which it already does for HTTP/1.1 Upgrade). Nitro itself is moved to a
 * loopback-only internal port (NITRO_PORT is remapped here BEFORE the
 * node-server entry reads it — plugins run first, verified against the
 * preset's built output).
 *
 * WHY Bun.serve fronts instead of Nitro/crossws: node:http upgrade socket
 * writes are broken under Bun (docker-matrix verified — engine.io WS died
 * with "read engine.io open: EOF"), while Bun.serve's native websocket is
 * unaffected. That regression is what retired socket.io from this app.
 *
 * Dev (`nuxt dev`) keeps the SIMPLER split topology: the gateway listens on
 * a dev-only port (31955) and the Vite dev server proxies /ws/* to it
 * (nuxt.config.ts) — fronting would fight the dev server for the port.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { onWsOpen, onWsMessage, onWsClose, type WsPeer } from '../services/media-node-ws'
import {
  authenticateAdmin,
  onAdminWsOpen,
  onAdminWsMessage,
  onAdminWsClose,
  initAdminWs,
  type AdminAuth,
} from '../services/admin-ws'

/** minimal structural types — keeps this independent of @types/bun resolution */
interface GatewaySocket {
  data: { kind: 'node' | 'admin'; peerId: string; auth?: AdminAuth }
  send: (data: string | Uint8Array) => number
  close: (code?: number, reason?: string) => void
}
interface GatewayServer {
  upgrade: (req: Request, opts?: { data?: unknown }) => boolean
}
interface GatewayOptions {
  port: number
  hostname?: string
  fetch: (req: Request, server: GatewayServer) => Promise<Response | undefined> | Response | undefined
  websocket: {
    open: (ws: GatewaySocket) => void
    message: (ws: GatewaySocket, message: string | Buffer) => void
    close: (ws: GatewaySocket) => void
  }
}
type BunGlobal = { serve: (opts: GatewayOptions) => unknown }

/** route() result when the connection was upgraded — the caller must NOT
 *  return any HTTP response afterwards (a response after a successful
 *  upgrade tears the connection down). */
const UPGRADED: unique symbol = Symbol('upgraded')

const IS_DEV = process.env.NODE_ENV === 'development'

/** dev-only standalone gateway port — MUST match the Vite proxy target in
 *  nuxt.config.ts (production fronts WS on the main PORT instead). */
const DEV_WS_PORT = 31955

export default defineNitroPlugin(() => {
  initAdminWs()

  const B = (globalThis as { Bun?: BunGlobal }).Bun
  if (!B?.serve) {
    console.log('[ws-gateway] non-Bun runtime — serving via crossws on the main port (/ws/*)')
    return
  }

  const peerOf = (ws: GatewaySocket): WsPeer => ({
    id: ws.data.peerId,
    send: (d) => {
      ws.send(d)
    },
    close: (c, r) => {
      ws.close(c, r)
    },
  })

  const websocket: GatewayOptions['websocket'] = {
    open: (ws) => {
      if (ws.data.kind === 'node') onWsOpen(peerOf(ws))
      else if (ws.data.auth) onAdminWsOpen(peerOf(ws), ws.data.auth)
    },
    message: (ws, message) => {
      if (ws.data.kind === 'node') {
        const data = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)
        void onWsMessage(peerOf(ws), data).catch((err) => {
          console.error('[ws-gateway] node message handling failed:', err)
          try {
            ws.close(1011)
          } catch {
            /* already closed */
          }
        })
      } else {
        onAdminWsMessage(peerOf(ws), typeof message === 'string' ? message : message.toString())
      }
    },
    close: (ws) => {
      if (ws.data.kind === 'node') onWsClose(peerOf(ws))
      else onAdminWsClose(peerOf(ws))
    },
  }

  if (IS_DEV) {
    // dev split topology: standalone gateway port, Vite proxies /ws/* to it
    // (coupled with the Vite proxy target in nuxt.config.ts — change both)
    const port = DEV_WS_PORT
    B.serve({
      port,
      hostname: process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : undefined,
      fetch: async (req, server) => {
        const path = new URL(req.url).pathname
        if (!path.startsWith('/ws/')) return new Response('not found', { status: 404 })
        const r = await wsRoute(req, server)
        return r === UPGRADED ? undefined : r
      },
      websocket,
    })
    console.log(`[ws-gateway] dev: Bun-native WS on :${port} (/ws/media-node, /ws/admin)`)
    return
  }

  // ── production FRONT mode ────────────────────────────────────────────────
  // This plugin runs BEFORE the node-server entry reads NITRO_PORT/PORT, so
  // remapping here moves Nitro to a loopback-only port while the gateway
  // takes over the public one. Zero deploy config: the container keeps
  // exposing exactly PORT (31954).
  const publicPort = Number(process.env.PORT || '31954')
  const internalPort = Number(process.env.INTERNAL_PORT || publicPort + 2)
  process.env.NITRO_PORT = String(internalPort)
  process.env.NITRO_HOST = '127.0.0.1'
  const upstream = `http://127.0.0.1:${internalPort}`

  B.serve({
    port: publicPort,
    websocket,
    fetch: async (req, server) => {
      const path = new URL(req.url).pathname
      if (path.startsWith('/ws/')) {
        const r = await wsRoute(req, server)
        return r === UPGRADED ? undefined : r
      }
      // static fast path: serve .output/public straight from disk with
      // precompressed negotiation. Proxying statics through fetch is NOT an
      // option: Bun's fetch auto-decompresses the upstream br/gz body while
      // keeping the content-encoding header, and the client then fails
      // decoding the doubly-(de)compressed bytes.
      const st = serveStatic(req)
      if (st) return st
      // reverse-proxy everything else to Nitro (Bun's documented pattern:
      // pass the Request OBJECT — bodies, methods, and streamed responses
      // all carry through untouched)
      const u = new URL(req.url)
      return fetch(upstream + u.pathname + u.search, req)
    },
  })
  console.log(`[ws-gateway] front mode: :${publicPort} (WS + static + proxy) → nitro 127.0.0.1:${internalPort}`)
})

/** /ws/* routing shared by both topologies. Returns UPGRADED when the
 *  connection was upgraded, or the HTTP response to send instead. */
async function wsRoute(req: Request, server: GatewayServer): Promise<Response | typeof UPGRADED> {
  const path = new URL(req.url).pathname
  if (path === '/ws/media-node') {
    return server.upgrade(req, { data: { kind: 'node', peerId: randomUUID() } })
      ? UPGRADED
      : new Response('upgrade failed', { status: 400 })
  }
  if (path === '/ws/admin') {
    const auth = await authenticateAdmin(req.headers.get('cookie'))
    if (!auth || auth.role !== 'admin') {
      return new Response('admin privileges required', { status: 403 })
    }
    return server.upgrade(req, { data: { kind: 'admin', peerId: randomUUID(), auth } })
      ? UPGRADED
      : new Response('upgrade failed', { status: 400 })
  }
  return new Response('not found', { status: 404 })
}

/* ---------------- static fast path (.output/public from disk) ---------------- */

const PUBLIC_DIR = resolve(process.cwd(), '.output/public')

const STATIC_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.map': 'application/json',
}

function fileResponse(abs: string, enc: 'br' | 'gzip' | null, immutable: boolean): Response {
  const headers = new Headers()
  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
  headers.set('content-type', STATIC_MIME[ext] ?? 'application/octet-stream')
  if (enc) headers.set('content-encoding', enc)
  headers.set('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0')
  headers.set('vary', 'accept-encoding')
  return new Response(Readable.toWeb(createReadStream(enc ? `${abs}.${enc === 'br' ? 'br' : 'gz'}` : abs)) as never, {
    headers,
  })
}

/** Serve a file from .output/public when it exists (precompressed variants
 *  negotiated by accept-encoding); null → fall through to the proxy. */
function serveStatic(req: Request): Response | null {
  const u = new URL(req.url)
  let rel: string
  try {
    rel = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  if (rel.includes('..') || rel.includes('\0')) return null
  const abs = resolve(PUBLIC_DIR, '.' + rel)
  if (!abs.startsWith(PUBLIC_DIR + sep)) return null
  const immutable = rel.startsWith('/_nuxt/') // content-hashed filenames

  const ae = req.headers.get('accept-encoding') ?? ''
  if (ae.includes('br') && existsSync(`${abs}.br`)) return fileResponse(abs, 'br', immutable)
  if (ae.includes('gzip') && existsSync(`${abs}.gz`)) return fileResponse(abs, 'gzip', immutable)
  try {
    if (statSync(abs).isFile()) return fileResponse(abs, null, immutable)
  } catch {
    /* not a static file */
  }
  return null
}
