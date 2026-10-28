import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptEnvelope, encryptEnvelope, fromBase64, toBase64, type EncryptionContext } from './envelope'

const context: EncryptionContext = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  mediaId: '22222222-2222-4222-8222-222222222222', purpose: 'original',
}
let key: CryptoKey

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
})
afterEach(() => vi.unstubAllGlobals())

describe('authenticated envelope v1', () => {
  it('round-trips exact bytes and includes version, IV, and tag', async () => {
    const original = new Uint8Array([0, 128, 255, 1])
    const envelope = await encryptEnvelope(key, original, context)
    expect(envelope[0]).toBe(1)
    expect(envelope.length).toBe(original.length + 29)
    await expect(decryptEnvelope(key, envelope, context)).resolves.toEqual(original)
  })

  it('supports authenticated empty plaintext', async () => {
    const envelope = await encryptEnvelope(key, new Uint8Array(), context)
    expect(envelope.length).toBe(29)
    await expect(decryptEnvelope(key, envelope, context)).resolves.toEqual(new Uint8Array())
  })

  it('generates fresh 96-bit IVs for repeated encryption', async () => {
    const ivs = new Set<string>()
    for (let i = 0; i < 64; i++) {
      const envelope = await encryptEnvelope(key, new Uint8Array([1]), context)
      ivs.add(toBase64(envelope.slice(1, 13)))
    }
    expect(ivs.size).toBe(64)
  })

  it.each([1, 13, 29])('rejects altered IV, ciphertext, or tag at byte %i', async (offset) => {
    const envelope = await encryptEnvelope(key, new Uint8Array([1, 2]), context)
    envelope[offset] ^= 1
    await expect(decryptEnvelope(key, envelope, context)).rejects.toThrow('Unable to decrypt')
  })

  it.each(['vaultId', 'mediaId', 'purpose'] as const)('rejects a substituted %s', async (field) => {
    const envelope = await encryptEnvelope(key, new Uint8Array([1]), context)
    const wrongContext = { ...context }
    if (field === 'purpose') wrongContext.purpose = 'thumbnail'
    else wrongContext[field] = '33333333-3333-4333-8333-333333333333'
    await expect(decryptEnvelope(key, envelope, wrongContext)).rejects.toThrow('Unable to decrypt')
  })

  it('rejects a different AES key', async () => {
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    const envelope = await encryptEnvelope(key, new Uint8Array([1]), context)
    await expect(decryptEnvelope(wrongKey, envelope, context)).rejects.toThrow('Unable to decrypt')
  })

  it('rejects AES-128 rather than silently weakening the configured cipher', async () => {
    const weakKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt'])
    await expect(encryptEnvelope(weakKey, new Uint8Array(), context)).rejects.toThrow('AES-256-GCM')
  })

  it.each([0, 1, 12, 28])('rejects a truncated envelope of %i bytes', async (length) => {
    await expect(decryptEnvelope(key, new Uint8Array(length), context)).rejects.toThrow('Malformed')
  })

  it('rejects an unsupported version', async () => {
    const envelope = await encryptEnvelope(key, new Uint8Array([1]), context)
    envelope[0] = 2
    await expect(decryptEnvelope(key, envelope, context)).rejects.toThrow('Unsupported')
  })

  it('rejects noncanonical IDs', async () => {
    await expect(encryptEnvelope(key, new Uint8Array(), { ...context, mediaId: 'photo.jpg' }))
      .rejects.toThrow('UUIDv4')
  })

  it('fails in insecure browser contexts', async () => {
    vi.stubGlobal('isSecureContext', false)
    await expect(encryptEnvelope(key, new Uint8Array(), context)).rejects.toThrow('trusted HTTPS')
  })
})

describe('bounded canonical base64', () => {
  it('round-trips binary public fields', () => {
    const bytes = new Uint8Array([0, 128, 255])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })
  it.each(['!', 'AA', 'AB==', 'AA==\n'])('rejects invalid/noncanonical base64 %j', (value) => {
    expect(() => fromBase64(value)).toThrow()
  })
  it('rejects oversized fields', () => {
    expect(() => fromBase64('A'.repeat(88_001))).toThrow()
    expect(() => toBase64(new Uint8Array(65_537))).toThrow()
  })
})
