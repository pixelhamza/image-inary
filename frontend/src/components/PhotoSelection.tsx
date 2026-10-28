import { useEffect, useRef, useState } from 'react'
import {
  MAX_SELECTED_PHOTOS, MAX_SELECTION_BYTES, validatePhoto,
  type ValidatedPhoto,
} from '../photos/validation'

type SelectedPhoto = ValidatedPhoto & { id: string; file: File; url: string }

export default function PhotoSelection({ onUpload, uploading = false }: {
  onUpload?: (files: File[]) => Promise<File[]>; uploading?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const photosRef = useRef<SelectedPhoto[]>([])
  const mounted = useRef(false)
  const busy = useRef(false)
  const [photos, setPhotos] = useState<SelectedPhoto[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url))
      photosRef.current = []
    }
  }, [])

  async function select(files: File[]) {
    if (busy.current || files.length === 0) return
    setErrors([])
    if (photosRef.current.length + files.length > MAX_SELECTED_PHOTOS) {
      setErrors([`Select up to ${MAX_SELECTED_PHOTOS} photos at a time. Remove some photos first.`])
      return
    }
    const totalBytes = [...photosRef.current.map((photo) => photo.file), ...files]
      .reduce((total, file) => total + file.size, 0)
    if (totalBytes > MAX_SELECTION_BYTES) {
      setErrors(['The selection exceeds 100 MiB. Choose fewer or smaller photos.'])
      return
    }

    busy.current = true
    setChecking(true)
    const failures: string[] = []
    try {
      // Sequential decoding avoids allocating several large image bitmaps at once.
      for (const file of files) {
        try {
          const details = await validatePhoto(file)
          if (!mounted.current) return
          const photo = { ...details, id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }
          photosRef.current = [...photosRef.current, photo]
          setPhotos(photosRef.current)
        } catch (error) {
          if (!mounted.current) return
          failures.push(`${file.name}: ${error instanceof Error ? error.message : 'Unable to read this photo.'}`)
        }
      }
      if (mounted.current) setErrors(failures)
    } finally {
      busy.current = false
      if (mounted.current) setChecking(false)
    }
  }

  function remove(id: string) {
    const photo = photosRef.current.find((item) => item.id === id)
    if (photo) URL.revokeObjectURL(photo.url)
    photosRef.current = photosRef.current.filter((item) => item.id !== id)
    setPhotos(photosRef.current)
  }

  async function upload() {
    if (!onUpload || checking || uploading) return
    const uploaded = await onUpload(photosRef.current.map((photo) => photo.file))
    for (const photo of [...photosRef.current]) {
      if (uploaded.includes(photo.file)) remove(photo.id)
    }
  }

  return (
    <section aria-labelledby="gallery-title">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 id="gallery-title" className="text-lg font-semibold">Local photo selection</h2>
          <p id="selection-help" className="mt-1 text-sm text-stone-600">PNG, JPEG, GIF · Up to 20 MiB per photo · 12 photos / 100 MiB total</p>
        </div>
        <button onClick={() => input.current?.click()} disabled={checking || uploading} aria-describedby="selection-help local-only-note" className="rounded-xl bg-emerald-900 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
          {checking ? 'Checking photos…' : '+ Select photos'}
        </button>
        <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" aria-label="Choose photos" className="sr-only" disabled={checking || uploading} onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void select(files)
        }} />
      </div>

      <p id="local-only-note" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        {onUpload ? 'Selected originals stay local until you choose Encrypt & upload. Only ciphertext is transferred.' : 'Local previews only. Unlock the vault to encrypt and upload. Nothing selected here is uploaded automatically.'} Selections disappear when you reload.
      </p>

      {errors.length > 0 && (
        <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-semibold">Some photos could not be selected</p>
          <ul className="mt-2 list-inside list-disc space-y-1 break-words">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
        </div>
      )}

      <p role="status" className="mb-4 text-sm text-stone-600">
        {checking ? 'Validating photo contents and dimensions…' : `${photos.length} photo${photos.length === 1 ? '' : 's'} selected locally`}
      </p>

      {photos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-6 py-20 text-center">
          <div aria-hidden="true" className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-900">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m3 17 5-5 4 4 3-3 6 6" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold">Your gallery starts here</h3>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-stone-600">Select photos to preview them on this device. Original files are kept unchanged, including animated GIFs.</p>
        </div>
      ) : (
        <ul aria-label="Selected photos" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
              <img src={photo.url} alt={photo.file.name} className="aspect-square w-full bg-stone-100 object-contain" />
              <div className="p-4">
                <p className="truncate text-sm font-semibold" title={photo.file.name}>{photo.file.name}</p>
                <p className="mt-1 text-xs text-stone-500">{photo.width} × {photo.height} · {(photo.file.size / 1024 / 1024).toFixed(2)} MiB</p>
                <button onClick={() => remove(photo.id)} disabled={checking || uploading} aria-label={`Remove ${photo.file.name}`} className="mt-3 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium hover:bg-stone-50 disabled:opacity-50">Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {photos.length > 0 && (
        <button onClick={() => { void upload() }} disabled={!onUpload || checking || uploading} className="mt-5 rounded-xl bg-emerald-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">Encrypt &amp; upload selected</button>
      )}
    </section>
  )
}
