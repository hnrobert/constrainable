/**
 * Public RSA key (as JWK) for client-side password encryption. Allowlisted (no
 * auth): the login/register page must fetch it before the user has a session.
 * The key is public by definition — handing it out reveals nothing.
 */
import { getPublicJwk } from '../../utils/rsa'

export default defineEventHandler(() => ({ jwk: getPublicJwk() }))
