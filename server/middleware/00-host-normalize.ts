/**
 * Host normalization: `0.0.0.0` is a bind address, never a browsing origin —
 * Safari/WebKit treat it as an opaque origin, so every "same-origin" XHR/fetch
 * (Socket.IO polling, the FLV playback proxy, crash reports) fails its access
 * control checks and the session cookie (host-scoped to `localhost`) never
 * rides along. Redirect any such Host to `localhost` once, and everything works.
 */
export default defineEventHandler((event) => {
  const host = getRequestHost(event)
  if (host.startsWith('0.0.0.0')) {
    const port = host.split(':')[1] || '31954'
    return sendRedirect(event, `http://localhost:${port}${event.node.req.url ?? '/'}`, 302)
  }
})
