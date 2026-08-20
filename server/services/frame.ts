/**
 * Latest-frame capture: ffmpeg pulls ONE video frame from the stream's FLV
 * and pipes it out as JPEG. Shared by the admin grid snapshot endpoint and
 * the user self-view endpoint (/api/me/frame). RTMP pulls are NOT used (SRS
 * RTMP-play starves on low-fps streams — see srs-url.ts); the tiny analysis
 * budget makes the frame arrive immediately.
 */
import { env } from '../utils/env'
import { buildFlvPullUrl } from '../utils/srs-url'
import { signMediaUrl } from '../utils/signed-url'
import { resolveFlvBase, getHostingNode } from '../services/media-node-registry'

export async function captureLatestFrame(stream: string): Promise<Uint8Array> {
  // Remote nodes: pull through the node's auth-gated play entry with a
  // self-signed URL (this app verifies its own signature on play:auth) — the
  // SRS sidecar never has to be exposed for snapshots. Local/single-server:
  // the internal FLV base as before.
  const hosted = getHostingNode(stream)
  const pullUrl = hosted?.publicOrigin
    ? signMediaUrl(hosted.publicOrigin, encodeURI(`/live/${stream}.flv`))
    : buildFlvPullUrl(stream, resolveFlvBase(stream))

  const proc = Bun.spawn({
    cmd: [
      env.ffmpegPath,
      '-v', 'error',
      '-probesize', '65536',
      '-analyzeduration', '2000000',
      '-i', pullUrl,
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'image2',
      'pipe:1',
    ],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const bytes = new Uint8Array(
    await new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
  )
  const timer = setTimeout(() => {
    try { proc.kill() } catch { /* already dead */ }
  }, 8_000)
  await proc.exited
  clearTimeout(timer)
  return bytes
}
