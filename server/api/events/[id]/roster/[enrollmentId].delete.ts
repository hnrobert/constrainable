/** Remove a roster entry (revokes its keys, drops the enrollment). */
import { removeEnrollment } from '../../../../services/roster'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const enrollmentId = Number(getRouterParam(event, 'enrollmentId'))
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(enrollmentId) || enrollmentId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }
  removeEnrollment(id, enrollmentId)
  setResponseStatus(event, 204)
  return null
})
