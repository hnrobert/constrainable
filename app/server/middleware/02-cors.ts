/**
 * CORS for split deployments: a static frontend served from ANOTHER origin
 * (e.g. CDN pages calling this API directly via the frontend's API_ORIGIN).
 * Active only when CORS_ORIGINS lists the allowed frontend origins — empty
 * (default) = same-origin deployment, no headers, exactly the pre-split
 * behavior. Requests carry the JWT session cookie, so credentials are
 * required and the requesting origin is echoed back, never '*'.
 */
import { getHeader, setHeader } from 'h3'
import { env } from '../utils/env'

export default defineEventHandler((event) => {
  if (env.corsOrigins.length === 0) return
  const origin = getHeader(event, 'origin')
  if (!origin || !env.corsOrigins.includes(origin)) return

  setHeader(event, 'access-control-allow-origin', origin)
  setHeader(event, 'access-control-allow-credentials', 'true')
  setHeader(event, 'access-control-allow-headers', 'content-type, authorization')
  setHeader(event, 'access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  setHeader(event, 'vary', 'Origin')

  // preflight — answer before routing; no handler should see it
  if (getMethod(event) === 'OPTIONS') {
    event.node.res.statusCode = 204
    event.node.res.end()
  }
})
