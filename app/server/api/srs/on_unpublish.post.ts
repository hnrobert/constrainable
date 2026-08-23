/** SRS http_hook: on_unpublish. Finalize recording, mark session ended. Always "0". */
import { handleUnpublish } from '../../services/stream-lifecycle'

export default defineEventHandler(async (event) => {
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseStatus(event, 200)

  const data = await readBody<any>(event)
  if (!data) return '0'

  const stream = String(data.stream ?? '')
  const app = String(data.app ?? '')
  const vhost = String(data.vhost ?? '__defaultVhost__')
  if (!stream) return '0'

  try {
    await handleUnpublish({ app, stream, vhost })
  } catch (err) {
    console.error('[srs] on_unpublish error:', err)
  }
  return '0'
})
