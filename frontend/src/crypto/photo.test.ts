import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptEnvelope, toBase64 } from './envelope'
import { decryptPhoto, decryptPhotoOriginal, decryptPhotoThumbnail, encryptPhoto, type EncryptedPhoto } from './photo'
import { createVault, unlockVault } from './vault'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
vi.mock('../photos/thumbnail', () => ({
  createThumbnail: vi.fn(async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
}))

const mediaId = '22222222-2222-4222-8222-222222222222'
const file = new File([png], 'private-location.png', { type: 'image/png', lastModified: 1234 })
let vault: Awaited<ReturnType<typeof createVault>>
let photo: EncryptedPhoto

function stubDecoder() {
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2, height: 3, close: vi.fn() }))
}

beforeAll(async () => {
  stubDecoder()
  vault = await createVault('synthetic photo test passphrase')
  photo = await encryptPhoto(vault.key, vault.config.id, mediaId, file)
})
beforeEach(stubDecoder)
afterEach(() => vi.unstubAllGlobals())

describe('per-photo encrypted record', () => {
  it('decrypts thumbnails without fetching the original, and originals without the thumbnail', async () => {
    const { original, thumbnail, ...index } = photo
    const summary = await decryptPhotoThumbnail(vault.key, vault.config.id, mediaId, { ...index, thumbnail })
    expect(summary.metadata.name).toBe(file.name)
    const full = await decryptPhotoOriginal(vault.key, vault.config.id, mediaId, { ...index, original })
    expect(full.original).toEqual(png)
  })

  it('rejects substituted IDs in thumbnail-only and original-only decryption', async () => {
    await expect(decryptPhotoThumbnail(vault.key, vault.config.id, crypto.randomUUID(), photo)).rejects.toThrow('Unable to decrypt')
    await expect(decryptPhotoOriginal(vault.key, vault.config.id, crypto.randomUUID(), photo)).rejects.toThrow('Unable to decrypt')
  })
  it('encrypts original, thumbnail, and metadata and recovers exact bytes', async () => {
    const restored = await decryptPhoto(vault.key, vault.config.id, mediaId, photo)
    expect(restored.original).toEqual(png)
    expect(restored.thumbnail.slice(0, 8)).toEqual(png.slice(0, 8))
    expect(restored.metadata).toEqual({
      version: 1, name: file.name, mime: file.type, width: 2, height: 3,
      size: file.size, lastModified: 1234,
    })
    expect(Object.keys(photo).sort()).toEqual(['metadata', 'original', 'thumbnail', 'version', 'wrappedKey'])
    expect(new TextDecoder().decode(photo.metadata)).not.toContain(file.name)
  })

  it('uses independent DEKs and fresh IVs for each operation', async () => {
    const other = await encryptPhoto(vault.key, vault.config.id, mediaId, file)
    const context = { vaultId: vault.config.id, mediaId, purpose: 'key-wrap' as const }
    const firstKey = await decryptEnvelope(vault.key, photo.wrappedKey, context)
    const secondKey = await decryptEnvelope(vault.key, other.wrappedKey, context)
    try {
      expect(firstKey.length).toBe(32)
      expect(firstKey).not.toEqual(secondKey)
    } finally {
      firstKey.fill(0)
      secondKey.fill(0)
    }
    const ivs = [photo, other].flatMap((record) =>
      [record.wrappedKey, record.original, record.thumbnail, record.metadata].map((value) => toBase64(value.slice(1, 13))),
    )
    expect(new Set(ivs).size).toBe(8)
  })

  it('recovers after deriving a new KEK from only public config and the passphrase', async () => {
    const recovered = await unlockVault('synthetic photo test passphrase', JSON.parse(JSON.stringify(vault.config)))
    await expect(decryptPhoto(recovered, vault.config.id, mediaId, photo)).resolves.toMatchObject({ original: png })
  })

  it.each(['wrappedKey', 'original', 'thumbnail', 'metadata'] as const)('rejects altered %s', async (field) => {
    const altered = { ...photo, [field]: new Uint8Array(photo[field]) }
    altered[field][altered[field].length - 1] ^= 1
    await expect(decryptPhoto(vault.key, vault.config.id, mediaId, altered)).rejects.toThrow('Unable to decrypt')
  })

  it('rejects media-ID substitution', async () => {
    await expect(decryptPhoto(vault.key, vault.config.id, crypto.randomUUID(), photo)).rejects.toThrow('Unable to decrypt')
  })

  it('rejects cross-purpose ciphertext substitution', async () => {
    await expect(decryptPhoto(vault.key, vault.config.id, mediaId, { ...photo, original: photo.thumbnail }))
      .rejects.toThrow('Unable to decrypt')
  })

  it('rejects malformed wrapped keys and unsupported record versions', async () => {
    await expect(decryptPhoto(vault.key, vault.config.id, mediaId, { ...photo, wrappedKey: new Uint8Array(32) }))
      .rejects.toThrow('Invalid encrypted photo record')
    await expect(decryptPhoto(vault.key, vault.config.id, mediaId, { ...photo, version: 2 } as unknown as EncryptedPhoto))
      .rejects.toThrow('Invalid encrypted photo record')
  })

  it('rejects non-photo plaintext before encryption', async () => {
    await expect(encryptPhoto(vault.key, vault.config.id, mediaId, new File(['text'], 'fake.jpg', { type: 'image/jpeg' })))
      .rejects.toThrow('Unsupported photo')
  })
})
