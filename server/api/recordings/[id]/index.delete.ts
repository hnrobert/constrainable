/** Delete a recording (row + on-disk file). */
import { deleteRecording } from '../../../services/recordings'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }
  deleteRecording(id)
  setResponseStatus(event, 204)
  return null
})
