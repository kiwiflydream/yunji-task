const IV_BYTES = 12

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const keyCache = new Map<string, Promise<CryptoKey>>()

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    const raw = fromBase64(secret)
    if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be base64 of exactly 32 bytes')
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    keyCache.set(secret, key)
  }
  return key
}

/** AES-GCM encrypt; `aad` binds the ciphertext to its owner (e.g. the variable name). */
export async function encryptString(secret: string, plaintext: string, aad: string): Promise<string> {
  const key = await importKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  )
  const out = new Uint8Array(IV_BYTES + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), IV_BYTES)
  return toBase64(out)
}

export async function decryptString(secret: string, encoded: string, aad: string): Promise<string> {
  const key = await importKey(secret)
  const data = fromBase64(encoded)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, IV_BYTES), additionalData: new TextEncoder().encode(aad) },
    key,
    data.slice(IV_BYTES),
  )
  return new TextDecoder().decode(pt)
}
