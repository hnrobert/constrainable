/**
 * Socket.IO server, attached to the SAME HTTP server as the app (port 31954).
 *
 * The node-server Nitro preset's entry (`.output/server/chunks/nitro/nitro.mjs`)
 * calls `server.listen()` directly and never emits the Nitro `listen` hook, so a
 * plugin can't grab the server at startup. Instead we lazily attach on the first
 * request: every Node request carries its HTTP server at
 * `event.node.req.socket.server`. `new SocketIOServer(server, …)` wraps the
 * server's `request`/`upgrade` listeners — `/socket/*` goes to engine.io,
 * everything else still reaches h3. Single port, both transports (polling +
 * websocket), identical in dev and prod. The client connects same-origin.
 *
 * This middleware is O(1) after the first request (`if (io) return`).
 */
import type http from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { onBus } from '../utils/bus'
import { env } from '../utils/env'
import { setSocketIO } from '../utils/socket-io'
import { wireMediaNodeNamespace } from '../services/media-node-events'
import type { BusEventMap, BusEventName } from '#shared/events'

const SOCKET_PATH = '/socket'

/** a Node net.Socket carries a back-reference to its http.Server at runtime,
 *  but `net.Socket` types don't declare `.server` — so we widen it ourselves. */
interface HttpServerWithFlags extends http.Server {
  __socketIoAttached?: boolean
  __io?: SocketIOServer
}
interface NetSocketWithServer {
  server?: HttpServerWithFlags
}

/** bus events forwarded verbatim to connected admin clients */
const FORWARD: BusEventName[] = [
  'session:start',
  'session:metric',
  'session:violation',
  'session:stop',
  'recording:ready',
  'audit:created',
  'config:changed',
]

let io: SocketIOServer | null = null

function wire(theIo: SocketIOServer): void {
  for (const name of FORWARD) {
    onBus(name, (payload: BusEventMap[typeof name]) => theIo.emit(name, payload))
  }
  theIo.on('connection', (s) => {
    console.log(`[socket.io] client connected (${s.id})`)
    s.on('disconnect', (reason) => console.log(`[socket.io] disconnected: ${reason}`))
  })
}

function remember(instance: SocketIOServer | null): void {
  io = instance
  // publish for handlers (node:kick etc.) — see utils/socket-io.ts
  setSocketIO(instance)
}

export default defineEventHandler((event) => {
  if (io) return
  const sock = event.node?.req?.socket as NetSocketWithServer | undefined
  const server = sock?.server
  if (!server) return
  // guard against double-attach (e.g. module reload in dev): once attached, the
  // server object — shared across ALL connections — is the source of truth, not
  // the module-level `io` variable. (The socket itself is per-connection.)
  if (server.__socketIoAttached) {
    remember(server.__io ?? null)
    return
  }
  io = new SocketIOServer(server, {
    path: SOCKET_PATH,
    transports: ['websocket', 'polling'],
    // Split deployment (CORS_ORIGINS set): echo only the allowed frontend
    // origins WITH credentials — the admin socket rides the session cookie.
    // Same-origin default: permissive (browser same-origin policy already
    // gates the handshake).
    cors:
      env.corsOrigins.length > 0
        ? { origin: env.corsOrigins, credentials: true }
        : { origin: '*' },
    serveClient: false,
  })
  server.__socketIoAttached = true
  server.__io = io
  remember(io)
  wire(io)
  // /media-nodes namespace: Go media-node backends connect here to register,
  // request publish authorization, and report session events.
  wireMediaNodeNamespace(io)
  console.log('[socket.io] attached to HTTP server (same origin, /socket/ + /media-nodes)')
})
