/**
 * RSA keypair for client-side password encryption. The browser fetches the
 * public key (as JWK) from GET /api/auth/pubkey, encrypts the password with
 * RSA-OAEP/SHA-256 via WebCrypto, and posts the base64 ciphertext; the server
 * decrypts it here with the private key before hashing.
 *
 * The private key PEM is persisted under its OWN app_config row key 'rsa' (like
 * the mail config) and cached in memory — read-through on first use, generated
 * lazily if absent. The key only protects passwords in transit; no stored data
 * depends on it, so a rotation (delete the row) just forces clients to re-fetch.
 */
import {
  constants,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto'
import { AppConfigRepository } from '../repositories/app-config.repository'

const KEY = 'rsa'

interface Cached {
  private: KeyObject
  /** JWK of the public key — safe to hand to the browser. */
  jwk: JsonWebKey
}

let _cache: Cached | null = null

function generate(): Cached {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  AppConfigRepository.upsertKey(KEY, JSON.stringify({ pem }))
  const jwk = publicKey.export({ format: 'jwk' })
  return { private: privateKey, jwk }
}

function load(): Cached {
  if (_cache) return _cache
  const row = AppConfigRepository.findKey(KEY)
  if (row) {
    try {
      const { pem } = JSON.parse(row.value) as { pem: string }
      const priv = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })
      const pub = createPublicKey(priv)
      _cache = { private: priv, jwk: pub.export({ format: 'jwk' }) }
      return _cache
    } catch (err) {
      console.error('[rsa] stored key unreadable, regenerating:', err)
    }
  }
  _cache = generate()
  return _cache
}

/** Public key as JWK — returned to the client for WebCrypto RSA-OAEP encryption. */
export function getPublicJwk(): JsonWebKey {
  return load().jwk
}

/**
 * Decrypt a base64 RSA-OAEP/SHA-256 ciphertext produced by the browser. Returns
 * the UTF-8 plaintext password. Throws on any failure (caller surfaces a 400).
 */
export function rsaDecrypt(cipherB64: string): string {
  const buf = Buffer.from(cipherB64, 'base64')
  const plain = privateDecrypt(
    { key: load().private, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    buf,
  )
  return plain.toString('utf8')
}
