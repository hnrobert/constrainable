/**
 * Builds OBS connection strings for a publisher. The ingest host is derived
 * at runtime — no env var needed for the standard deployment:
 *   1. PUBLIC_HOST override (runtime config) when set explicitly
 *   2. API_ORIGIN's hostname in split deployments (frontend elsewhere; OBS
 *      pushes to the origin server)
 *   3. the origin the user is BROWSING from (wherever the app is reachable,
 *      RTMP :1935 is reachable too)
 * The default port 1935 is omitted — `rtmp://host/live`.
 */
export function useObsConfig() {
  const cfg = useRuntimeConfig()
  const requestUrl = useRequestURL()

  const ingestHost =
    hostnameOf(String(cfg.public.srsPublicHost || '')) ||
    hostnameOf(String(cfg.public.apiOrigin || '')) ||
    requestUrl.hostname
  const port = Number(cfg.public.srsRtmpPort || 1935)
  const server = computed(
    () => `rtmp://${ingestHost}${port === 1935 ? '' : `:${port}`}/live`,
  )
  function streamKey(streamName: string, token: string): string {
    return `${streamName}?token=${token}`
  }
  return { server, streamKey }
}

/** hostname of an http(s) origin string ('' when not parseable) */
function hostnameOf(origin: string): string {
  if (!origin) return ''
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}
