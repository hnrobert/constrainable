/**
 * Singleton Socket.IO client. The server attaches socket.io to the SAME origin
 * as the app (lazy on first request, same port), so we connect same-origin with
 * no explicit host/port.
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
  _socket = io({
    path: '/socket',
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
