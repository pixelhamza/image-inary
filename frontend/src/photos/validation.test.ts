import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectPhotoMime, MAX_PHOTO_BYTES, validatePhoto } from './validation'

const png = [137, 80, 78, 71, 13, 10, 26, 10]
const jpeg = [255, 216, 255, 224]
const gif87 = [71, 73, 70, 56, 55, 97]
const gif89 = [71, 73, 70, 56, 57, 97]

afterEach(() => vi.unstubAllGlobals())

describe('photo signatures', () => {
  it.each([
    [png, 'image/png'], [jpeg, 'image/jpeg'],
    [gif87, 'image/gif'], [gif89, 'image/gif'],
  ] as const)('detects %j as %s', (signature, mime) => {
    expect(detectPhotoMime(new Uint8Array(signature))).toBe(mime)
  })

  it.each([[], [137, 80, 78], [255, 216], [71, 73, 70, 56, 57], [82, 73, 70, 70]])(
    'rejects unsupported or truncated headers: %j', (...bytes) => {
      expect(() => detectPhotoMime(new Uint8Array(bytes))).toThrow('Unsupported photo')
    },
  )
})

describe('photo validation', () => {
  it('rejects an empty file', async () => {
    await expect(validatePhoto(new File([], 'empty.png', { type: 'image/png' })))
      .rejects.toThrow('empty')
  })

  it('rejects oversized files before reading or decoding', async () => {
    const file = new File([], 'large.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: MAX_PHOTO_BYTES + 1 })
    await expect(validatePhoto(file)).rejects.toThrow('20 MiB')
  })

  it('rejects a renamed non-photo', async () => {
    const file = new File(['not a photo'], 'fake.jpg', { type: 'image/jpeg' })
    await expect(validatePhoto(file)).rejects.toThrow('Unsupported photo')
  })

  it('rejects MIME/signature mismatches', async () => {
    const file = new File([new Uint8Array(png)], 'fake.jpg', { type: 'image/jpeg' })
    await expect(validatePhoto(file)).rejects.toThrow('does not match')
  })

  it('reports browser decode failures as corrupt photos', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')))
    await expect(validatePhoto(new File([new Uint8Array(png)], 'broken.png')))
      .rejects.toThrow('corrupt')
  })

  it('accepts missing MIME using content and preserves original GIF bytes', async () => {
    const close = vi.fn()
    const decode = vi.fn().mockResolvedValue({ width: 2, height: 3, close })
    vi.stubGlobal('createImageBitmap', decode)
    const file = new File([new Uint8Array(gif89)], 'photo.gif')
    const before = await file.arrayBuffer()
    await expect(validatePhoto(file)).resolves.toEqual({ mime: 'image/gif', width: 2, height: 3 })
    expect(decode).toHaveBeenCalledWith(file)
    expect(await file.arrayBuffer()).toEqual(before)
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([[0, 1], [1, 0], [10_000, 10_000]])(
    'rejects invalid or excessive dimensions %i × %i and releases the bitmap', async (width, height) => {
      const close = vi.fn()
      vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }))
      await expect(validatePhoto(new File([new Uint8Array(png)], 'photo.png')))
        .rejects.toThrow('40 megapixels')
      expect(close).toHaveBeenCalledOnce()
    },
  )
})
