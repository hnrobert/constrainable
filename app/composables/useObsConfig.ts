/**
 * Builds OBS connection strings for a publisher. The ingest host is derived
 * at runtime, in priority order:
 *   1. PUBLIC_HOST override (runtime config) when set explicitly
 *   2. the user's ASSIGNED media node's public origin (admin-assigned or
 *      first-visit auto-allocation — see services/node-assignment.ts)
 *   3. API_ORIGIN's hostname in split deployments (frontend elsewhere; OBS
 *      pushes to the origin server)
 *   4. the origin the user is BROWSING from (wherever the app is reachable,
 *      RTMP :1935 is reachable too)
 * The default port 1935 is omitted — `rtmp://host/live`.
 */
export function useObsConfig() {
  const cfg = useRuntimeConfig()
  const requestUrl = useRequestURL()

  // the caller's node assignment (null when logged out / unassigned / the
  // node has no public origin — single-server default)
  const { data: assignment } = useFetch<{ assigned: string | null; assignedPublicOrigin: string }>(
    '/api/nodes/assignment',
    { default: () => ({ assigned: null, assignedPublicOrigin: '' }) },
  )

  const ingestHost = computed(() => {
    const override = hostnameOf(String(cfg.public.srsPublicHost || ''))
    if (override) return override
    const assigned = hostnameOf(assignment.value.assignedPublicOrigin)
    if (assigned) return assigned
    const api = hostnameOf(String(cfg.public.apiOrigin || ''))
    if (api) return api
    return requestUrl.hostname
  })
  const port = Number(cfg.public.srsRtmpPort || 1935)
  const server = computed(
    () => `rtmp://${ingestHost.value}${port === 1935 ? '' : `:${port}`}/live`,
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
