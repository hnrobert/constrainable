/**
 * Singleton Socket.IO client. Same-origin by default: the server attaches
 * socket.io to the SAME origin as the app (lazy on first request, same port),
 * so we connect with no explicit host/port. Split deployments (API_ORIGIN
 * set — static frontend elsewhere) connect to the API origin with
 * withCredentials so the session cookie rides the handshake.
 *
 * Transports are dev/prod split:
 *  - Dev: polling ONLY. The Nitro dev server runs behind Vite, which proxies
 *    HTTP (so polling reaches engine.io) but does NOT forward WebSocket
 *    upgrades — so a websocket probe fails with a noisy "WebSocket is closed
 *    before the connection is established" console error. Polling alone is
 *    rock-solid in dev and keeps the console clean.
 *  - Prod: polling + websocket. Vite is out of the loop, so engine.io probes
 *    the websocket upgrade and it succeeds (efficient, lower latency).
 *
 * Client-only: call from onMounted / a .client plugin (no window on SSR).
 */
import { io, type Socket } from 'socket.io-client'

let _socket: Socket | null = null

export function useSocket(): Socket {
  if (_socket) return _socket
  // split deployment: talk to the API origin instead of the serving origin
  const apiOrigin = String(useRuntimeConfig().public.apiOrigin || '')
  _socket = io(apiOrigin || undefined, {
    path: '/socket',
    withCredentials: !!apiOrigin,
    transports: import.meta.dev ? ['polling'] : ['polling', 'websocket'],
    autoConnect: true,
    reconnection: true,
  })
  return _socket
}

export function disposeSocket(): void {
  if (_socket) {
    _socket.disconnect()
    _socket = null
  }
}
