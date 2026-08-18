/**
 * Module-level holder for the Socket.IO server instance. The 00-socket
 * middleware attaches it lazily (first request) and stores it here so API
 * handlers can emit into namespaces (e.g. `node:kick` on /media-node) without
 * importing the middleware module itself.
 */
import type { Server as SocketIOServer } from 'socket.io'

let io: SocketIOServer | null = null

export function setSocketIO(instance: SocketIOServer | null): void {
  io = instance
}

/** The Socket.IO server once attached (null before the first request). */
export function getSocketIO(): SocketIOServer | null {
  return io
}
