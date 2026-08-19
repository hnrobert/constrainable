/**
 * OBS server URL composition, shared by the guide page (useObsConfig) and the
 * admin nodes table. The standard RTMP port 1935 is omitted from the rendered
 * URL — contestants paste a clean `rtmp://host/live`; any other port
 * (`host:21935`) is kept.
 */

/** Strip a redundant :1935 from an authority ("host:1935" → "host"). */
export function normalizeRtmpAuthority(authority: string): string {
  return authority.replace(/:1935$/, '')
}

/** rtmp://<authority>/live with a redundant :1935 omitted. */
export function obsServerUrl(authority: string): string {
  return `rtmp://${normalizeRtmpAuthority(authority)}/live`
}
