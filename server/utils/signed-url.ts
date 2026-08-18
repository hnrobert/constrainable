/**
 * HMAC-SHA256 signed URLs for Go media-node video endpoints. The Node control
 * plane mints these; the Go node verifies them (same shared secret =
 * MEDIA_NODE_AUTH_TOKEN). Format:
 *
 *   {nodeOrigin}{path}?exp={unixSeconds}&sig={hex}
 *
 * sig = HMAC-SHA256(MEDIA_NODE_AUTH_TOKEN, "GET {path} {exp}")
 * TTL: 10 minutes. Go allows ±60s clock skew.
 */
import { createHmac } from 'node:crypto'
import { env } from './env'

const TTL_SEC = 10 * 60

/**
 * Mint a signed URL pointing at a Go media node's HTTP endpoint.
 * The path must start with "/" (e.g. "/live/stream@user.flv").
 */
export function signMediaUrl(nodeOrigin: string, path: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC
  const sig = createHmac('sha256', env.mediaNodeAuthToken || 'insecure')
    .update(`GET ${path} ${exp}`)
    .digest('hex')
  const origin = nodeOrigin.replace(/\/$/, '')
  return `${origin}${path}?exp=${exp}&sig=${sig}`
}
