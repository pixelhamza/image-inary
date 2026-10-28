export const ENVELOPE_VERSION = 1
export const ENVELOPE_OVERHEAD = 29
export type Purpose = 'original' | 'thumbnail' | 'metadata' | 'key-wrap' | 'vault-check'
export type EncryptionContext = { vaultId: string; mediaId: string; purpose: Purpose }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const purposes: Purpose[] = ['original', 'thumbnail', 'metadata', 'key-wrap', 'vault-check']

export function webCrypto(): Crypto {
  if (globalThis.isSecureContext === false || !globalThis.crypto?.subtle) {
    throw new Error('Web Crypto requires localhost or trusted HTTPS.')
  }
  return globalThis.crypto
}

export function assertID(id: string): void {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Expected a canonical UUIDv4 identifier.')
}

function assertAES256Key(key: CryptoKey): void {
  if (key.type !== 'secret' || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) {
    throw new Error('Expected an AES-256-GCM key.')
  }
}

function additionalData(context: EncryptionContext): Uint8Array<ArrayBuffer> {
  assertID(context.vaultId)
  assertID(context.mediaId)
  if (!purposes.includes(context.purpose)) throw new Error('Unsupported encryption purpose.')
  if (context.purpose === 'vault-check' && context.vaultId !== context.mediaId) {
    throw new Error('Invalid vault-check context.')
  }
  return new TextEncoder().encode(JSON.stringify([
    'imageinary', ENVELOPE_VERSION, context.vaultId, context.mediaId, context.purpose,
  ]))
}

export async function encryptEnvelope(
  key: CryptoKey, plaintext: Uint8Array, context: EncryptionContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = webCrypto()
  assertAES256Key(key)
  const aad = additionalData(context)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, new Uint8Array(plaintext),
  )
  const envelope = new Uint8Array(13 + ciphertext.byteLength)
  envelope[0] = ENVELOPE_VERSION
  envelope.set(iv, 1)
  envelope.set(new Uint8Array(ciphertext), 13)
  return envelope
}

export async function decryptEnvelope(
  key: CryptoKey, envelope: Uint8Array, context: EncryptionContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = webCrypto()
  assertAES256Key(key)
  const aad = additionalData(context)
  if (envelope.length < ENVELOPE_OVERHEAD) throw new Error('Malformed encrypted envelope.')
  if (envelope[0] !== ENVELOPE_VERSION) throw new Error('Unsupported encrypted envelope version.')
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: new Uint8Array(envelope.slice(1, 13)),
      additionalData: aad, tagLength: 128,
    }, key, new Uint8Array(envelope.slice(13))))
  } catch {
    throw new Error('Unable to decrypt: wrong passphrase or damaged data.')
  }
}

export function toBase64(bytes: Uint8Array): string {
  // Only small public config / wrapped-key / encrypted metadata fields need base64.
  if (bytes.length > 64 * 1024) throw new Error('Base64 field is too large.')
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 88_000) throw new Error('Invalid base64 field.')
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    throw new Error('Invalid base64 field.')
  }
  if (toBase64(bytes) !== value) throw new Error('Noncanonical base64 field.')
  return bytes
}
