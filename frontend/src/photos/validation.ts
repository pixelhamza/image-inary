export const MAX_PHOTO_BYTES = 20 * 1024 * 1024
export const MAX_PHOTO_PIXELS = 40_000_000
export const MAX_SELECTED_PHOTOS = 12
export const MAX_SELECTION_BYTES = 100 * 1024 * 1024

export type PhotoMime = 'image/png' | 'image/jpeg' | 'image/gif'
export type ValidatedPhoto = { mime: PhotoMime; width: number; height: number }

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

export function detectPhotoMime(bytes: Uint8Array): PhotoMime {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png'
  if (startsWith(bytes, [255, 216, 255])) return 'image/jpeg'
  if (
    startsWith(bytes, [71, 73, 70, 56, 55, 97]) ||
    startsWith(bytes, [71, 73, 70, 56, 57, 97])
  ) return 'image/gif'
  throw new Error('Unsupported photo. Choose a PNG, JPEG, or GIF file.')
}

// Checks content independently of the filename. Decoding detects corrupt images;
// it does not re-encode or replace the original file (including animated GIFs).
export async function validatePhoto(file: File): Promise<ValidatedPhoto> {
  if (file.size === 0) throw new Error('This file is empty.')
  if (file.size > MAX_PHOTO_BYTES) throw new Error('Photo exceeds the 20 MiB limit.')

  const mime = detectPhotoMime(new Uint8Array(await file.slice(0, 12).arrayBuffer()))
  if (file.type && file.type.toLowerCase() !== mime) {
    throw new Error('The file type does not match its contents.')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('This photo is corrupt or cannot be decoded by this browser.')
  }
  try {
    const { width, height } = bitmap
    if (width < 1 || height < 1 || width * height > MAX_PHOTO_PIXELS) {
      throw new Error('Photo dimensions must be valid and no larger than 40 megapixels.')
    }
    return { mime, width, height }
  } finally {
    bitmap.close()
  }
}
