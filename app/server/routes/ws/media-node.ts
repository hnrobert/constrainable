/**
 * Raw WebSocket endpoint for Go media nodes — the protobuf Envelope control
 * channel (see services/media-node-ws.ts and proto/control/v1/control.proto).
 * Requires nitro experimental.websocket (nuxt.config.ts); coexists with the
 * socket.io /socket path used by admin browsers.
 */
import { defineWebSocketHandler } from 'h3'
import { onWsOpen, onWsMessage, onWsClose } from '../../services/media-node-ws'

export default defineWebSocketHandler({
  open: (peer) => onWsOpen(peer),
  message: (peer, message) => {
    void onWsMessage(peer, message.uint8Array()).catch((err) => {
      console.error('[media-ws] message handling failed:', err)
      peer.close(1011)
    })
  },
  close: (peer) => onWsClose(peer),
  error: (peer, error) => console.error('[media-ws] peer error:', peer.id, error),
})
