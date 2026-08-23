/**
 * Client-side RSA-OAEP password encryption. Before login/register the plaintext
 * password is encrypted with the server's RSA public key (served as JWK at
 * /api/auth/pubkey) so the wire never carries the raw password — even over HTTP
 * on the intranet. The server decrypts with node:crypto using
 * RSA_PKCS1_OAEP_PADDING + SHA-256 (see server/utils/rsa.ts), which matches
 * WebCrypto's RSA-OAEP/SHA-256 with an empty label.
 *
 * Only ever invoked from client event handlers, so crypto.subtle/btoa are
 * present; we guard anyway so a broken SSR path degrades instead of crashing.
 */
let cachedKey: CryptoKey | null = null
let inflight: Promise<CryptoKey> | null = null

async function loadKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  if (inflight) return inflight
  inflight = (async () => {
    const { jwk } = await $fetch<{ jwk: JsonWebKey }>('/api/auth/pubkey')
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
    cachedKey = key
    return key
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

/**
 * Encrypt a plaintext password for transmission. Returns the base64 ciphertext.
 * If WebCrypto is somehow unavailable, returns the plaintext unchanged so the
 * request still proceeds (the server will reject a too-short plaintext).
 */
export async function encryptPassword(plain: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return plain
  const key = await loadKey()
  const enc = new TextEncoder().encode(plain)
  const cipher = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, enc)
  return toBase64(cipher)
}
