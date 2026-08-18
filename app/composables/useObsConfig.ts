/**
 * Builds OBS connection strings for a student, using the browser-visible SRS
 * host (LAN/public IP) from runtime config. The stream key embeds the secret
 * token: `rtmp://host:1935/live` + key `${streamName}?token=...`.
 */
export function useObsConfig() {
  const cfg = useRuntimeConfig()
  const server = computed(
    () => `rtmp://${cfg.public.srsPublicHost}:${cfg.public.srsRtmpPort}/live`,
  )
  function streamKey(streamName: string, token: string): string {
    return `${streamName}?token=${token}`
  }
  return { server, streamKey }
}
