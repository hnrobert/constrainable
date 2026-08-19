/**
 * The caller's node-assignment state + browser probe targets. Logged-in
 * users get their assignment + the public origins to latency-probe;
 * anonymous callers get empty values (200, not 403) so public guide pages
 * can use the composable without SSR error noise.
 */
import { getAuth } from '../../utils/auth'
import { assignmentView } from '../../services/node-assignment'

export default defineEventHandler((event) => {
  const auth = getAuth(event)
  if (!auth) return { assigned: null, assignedPublicOrigin: '', assignedPublicRtmpPort: 1935, probe: [] }
  return assignmentView(auth.userId)
})
