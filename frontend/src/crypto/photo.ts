import { createThumbnail } from '../photos/thumbnail'
import { detectPhotoMime, MAX_PHOTO_BYTES, MAX_PHOTO_PIXELS, validatePhoto, type PhotoMime } from '../photos/validation'
import { assertID, decryptEnvelope, encryptEnvelope, ENVELOPE_OVERHEAD, webCrypto, type Purpose } from './envelope'

export type EncryptedPhoto = {
  version: 1
  wrappedKey: Uint8Array
  original: Uint8Array
  thumbnail: Uint8Array
  metadata: Uint8Array
}
export type PhotoMetadata = {
  version: 1; name: string; mime: PhotoMime; width: number; height: number
  size: number; lastModified: number
}

export async function encryptPhoto(
  kek: CryptoKey, vaultId: string, mediaId: string, file: File,
): Promise<EncryptedPhoto> {
  assertID(vaultId)
  assertID(mediaId)
  if (file.name.length > 1024) throw new Error('Photo filename is too long.')
  const details = await validatePhoto(file)
  const thumbnail = await createThumbnail(file)
  const metadata: PhotoMetadata = {
    version: 1, name: file.name, ...details, size: file.size, lastModified: file.lastModified,
  }
  const crypto = webCrypto()
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  let key: CryptoKey
  let wrappedKey: Uint8Array
  try {
    key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
    wrappedKey = await encryptEnvelope(kek, rawKey, { vaultId, mediaId, purpose: 'key-wrap' })
  } finally {
    rawKey.fill(0)
  }
  const encrypt = (bytes: Uint8Array, purpose: Purpose) => encryptEnvelope(key, bytes, { vaultId, mediaId, purpose })
  return {
    version: 1, wrappedKey,
    original: await encrypt(new Uint8Array(await file.arrayBuffer()), 'original'),
    thumbnail: await encrypt(thumbnail, 'thumbnail'),
    metadata: await encrypt(new TextEncoder().encode(JSON.stringify(metadata)), 'metadata'),
  }
}

function parseMetadata(bytes: Uint8Array): PhotoMetadata {
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (typeof data !== 'object' || data === null) throw new Error('Invalid encrypted photo metadata.')
  const meta = data as Partial<PhotoMetadata>
  if (
    meta.version !== 1 || typeof meta.name !== 'string' || meta.name.length > 1024 ||
    !['image/png', 'image/jpeg', 'image/gif'].includes(meta.mime ?? '') ||
    typeof meta.width !== 'number' || !Number.isSafeInteger(meta.width) || meta.width < 1 ||
    typeof meta.height !== 'number' || !Number.isSafeInteger(meta.height) || meta.height < 1 ||
    meta.width * meta.height > MAX_PHOTO_PIXELS ||
    typeof meta.size !== 'number' || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > MAX_PHOTO_BYTES ||
    typeof meta.lastModified !== 'number' || !Number.isSafeInteger(meta.lastModified)
  ) throw new Error('Invalid encrypted photo metadata.')
  return meta as PhotoMetadata
}

export async function decryptPhoto(
  kek: CryptoKey, vaultId: string, mediaId: string, photo: EncryptedPhoto,
): Promise<{ original: Uint8Array; thumbnail: Uint8Array; metadata: PhotoMetadata }> {
  if (
    photo.original.length > MAX_PHOTO_BYTES + ENVELOPE_OVERHEAD ||
    photo.thumbnail.length > 1024 * 1024 + ENVELOPE_OVERHEAD
  ) throw new Error('Invalid encrypted photo record.')
  const { key, metadata } = await unlockPhoto(kek, vaultId, mediaId, photo)
  const decrypt = (bytes: Uint8Array, purpose: Purpose) => decryptEnvelope(key, bytes, { vaultId, mediaId, purpose })
  const original = await decrypt(photo.original, 'original')
  const thumbnail = await decrypt(photo.thumbnail, 'thumbnail')
  if (original.length !== metadata.size || detectPhotoMime(original) !== metadata.mime || detectPhotoMime(thumbnail) !== 'image/png') {
    throw new Error('Invalid decrypted photo contents.')
  }
  return { original, thumbnail, metadata }
}

type PhotoIndex = Pick<EncryptedPhoto, 'version' | 'wrappedKey' | 'metadata'>

async function unlockPhoto(kek: CryptoKey, vaultId: string, mediaId: string, photo: PhotoIndex) {
  assertID(vaultId)
  assertID(mediaId)
  if (photo.version !== 1 || photo.wrappedKey.length !== 32 + ENVELOPE_OVERHEAD || photo.metadata.length > 16 * 1024 + ENVELOPE_OVERHEAD) {
    throw new Error('Invalid encrypted photo record.')
  }
  const raw = await decryptEnvelope(kek, photo.wrappedKey, { vaultId, mediaId, purpose: 'key-wrap' })
  let key: CryptoKey
  try {
    if (raw.length !== 32) throw new Error('Invalid wrapped photo key.')
    key = await webCrypto().subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['decrypt'])
  } finally { raw.fill(0) }
  const metadata = parseMetadata(await decryptEnvelope(key, photo.metadata, { vaultId, mediaId, purpose: 'metadata' }))
  return { key, metadata }
}

export async function decryptPhotoThumbnail(
  kek: CryptoKey, vaultId: string, mediaId: string, photo: PhotoIndex & Pick<EncryptedPhoto, 'thumbnail'>,
): Promise<{ thumbnail: Uint8Array; metadata: PhotoMetadata }> {
  if (photo.thumbnail.length > 1024 * 1024 + ENVELOPE_OVERHEAD) throw new Error('Invalid encrypted thumbnail.')
  const { key, metadata } = await unlockPhoto(kek, vaultId, mediaId, photo)
  const thumbnail = await decryptEnvelope(key, photo.thumbnail, { vaultId, mediaId, purpose: 'thumbnail' })
  if (detectPhotoMime(thumbnail) !== 'image/png') throw new Error('Invalid decrypted thumbnail.')
  return { thumbnail, metadata }
}

export async function decryptPhotoOriginal(
  kek: CryptoKey, vaultId: string, mediaId: string, photo: PhotoIndex & Pick<EncryptedPhoto, 'original'>,
): Promise<{ original: Uint8Array; metadata: PhotoMetadata }> {
  if (photo.original.length > MAX_PHOTO_BYTES + ENVELOPE_OVERHEAD) throw new Error('Invalid encrypted original.')
  const { key, metadata } = await unlockPhoto(kek, vaultId, mediaId, photo)
  const original = await decryptEnvelope(key, photo.original, { vaultId, mediaId, purpose: 'original' })
  if (original.length !== metadata.size || detectPhotoMime(original) !== metadata.mime) throw new Error('Invalid decrypted photo contents.')
  return { original, metadata }
}
