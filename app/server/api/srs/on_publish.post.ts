/**
 * SRS http_hook: on_publish. Body is the SRS publish payload. Returns plain-text
 * "0" to allow the publish, or "1" to reject (SRS drops the connection on any
 * body ≠ "0" or non-200). We respond "0" immediately and monitor asynchronously.
 *
 * No auth — SRS is the only caller (allowlisted in middleware, Phase 8).
 */
import { handlePublish } from '../../services/stream-lifecycle'

export default defineEventHandler(async (event) => {
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseStatus(event, 200)

  const data = await readBody<any>(event)
  if (!data) return '1'

  const action = String(data.action ?? 'on_publish')
  const clientId = String(data.client_id ?? '')
  const stream = String(data.stream ?? '')
  const app = String(data.app ?? '')
  const vhost = String(data.vhost ?? '__defaultVhost__')
  const param = String(data.param ?? '')

  if (action === 'on_unpublish') return '0' // dedicated route handles this
  if (!stream || !app) return '1'

  try {
    const res = await handlePublish({ app, stream, vhost, clientId, param })
    return res.allow ? '0' : '1'
  } catch (err) {
    // fail-closed (matches Python returning "-1"): reject on unexpected error
    console.error('[srs] on_publish error:', err)
    return '1'
  }
})
