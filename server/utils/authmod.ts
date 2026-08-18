/**
 * Adobe RTMP `authmod=adobe` challenge-response math, server side.
 *
 * When an RTMP server challenges a publisher, OBS (librtmp) reconnects twice and
 * finally sends, in the `app` query string:
 *
 *   ?authmod=adobe&user=<U>&challenge=<C>&response=<R>&opaque=<O>
 *
 * The password never travels. librtmp computes, locally:
 *
 *   salted2  = base64( md5(user + salt + password) )      // the stored verifier
 *   response = base64( md5(salted2 + opaque + challenge) )
 *
 * `salt` + `opaque` are server-chosen (sent in the stage-2 challenge); `challenge`
 * is a client random echoed back. So the server can verify ONLY if it can recover
 * `salted2` — i.e. it must store it, computed at registration when the plaintext
 * password is available. `salt` must be STABLE per user (it is folded into the
 * stored verifier); `opaque` and `challenge` are per-session.
 *
 * `user` is the OBS *Username* field = the account email, and must equal the exact
 * string used to mint the verifier (the guide shows the verbatim email to copy).
 * Verified against librtmp 2026-08-14 (two live captures, byte-exact) — see
 * docs/STREAMING.md "OBS 'Use authentication' — how it works".
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { encrypt, decrypt } from './crypto'

const b64 = (b: Buffer): string => b.toString('base64')
const md5 = (s: string): Buffer => createHash('md5').update(s, 'utf8').digest()

/** A stable, query-safe per-user salt (hex — no '&','=' to corrupt the challenge). */
export const generateSalt = (): string => randomBytes(8).toString('hex')

/**
 * The stored verifier: base64(md5(user + salt + password)) — librtmp's `salted2`.
 * `user` = the account email (normalized, lowercased — the value the guide shows).
 */
export const computeVerifier = (user: string, salt: string, password: string): string =>
  b64(md5(`${user}${salt}${password}`))

/** Compute a fresh (salt, encrypted-verifier) pair for at-rest storage. */
export function mintAuthmod(user: string, password: string): { salt: string; verifierCipher: string } {
  const salt = generateSalt()
  return { salt, verifierCipher: encrypt(computeVerifier(user, salt, password)) }
}

/** Decrypt a stored verifier back to librtmp's `salted2`. */
export const verifierFromCipher = (verifierCipher: string): string => decrypt(verifierCipher)

/**
 * Verify an Adobe authmod `response`. True iff the client proved knowledge of the
 * password. `storedVerifier` = decrypted `salted2`; `opaque` = what the server
 * sent in stage 2; `challenge` = the client random echoed back.
 */
export function verifyResponse(args: {
  storedVerifier: string
  opaque: string
  challenge: string
  response: string
}): boolean {
  const expected = b64(md5(`${args.storedVerifier}${args.opaque}${args.challenge}`))
  const a = Buffer.from(expected)
  const b = Buffer.from(args.response)
  return a.length === b.length && timingSafeEqual(a, b)
}
