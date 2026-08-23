/** Return the current authenticated user, or null. */
import { UsersRepository } from '../../repositories/users.repository'

export default defineEventHandler((event) => {
  const auth = event.context.auth
  if (!auth) return null
  const user = UsersRepository.findById(auth.userId)
  if (!user) return null
  return { id: user.id, email: user.email, role: user.role }
})
