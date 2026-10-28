import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createGalleryClient, downloadCiphertext, uploadCiphertext, type MediaRecord } from '../api/gallery'
import { fromBase64, toBase64 } from '../crypto/envelope'
import { decryptPhotoOriginal, decryptPhotoThumbnail, encryptPhoto, type PhotoMetadata } from '../crypto/photo'
import { createVault, unlockVault, type VaultConfig } from '../crypto/vault'
import OriginalPreview, { downloadName } from './OriginalPreview'
import PhotoSelection from './PhotoSelection'

type Client = ReturnType<typeof createGalleryClient>
type Session = { client: Client; config: VaultConfig; key: CryptoKey }
type GalleryItem = { record: MediaRecord; metadata?: PhotoMetadata; url?: string; error?: string }
type Preview = { id: string; name: string; url: string }
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Please retry.'

export default function VaultGallery() {
  const [credential, setCredential] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [connection, setConnection] = useState<{ client: Client; config: VaultConfig | null } | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [items, setItems] = useState<GalleryItem[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [selectionVersion, setSelectionVersion] = useState(0)
  const epoch = useRef(0)
  const alive = useRef(false)
  const working = useRef(false)
  const controller = useRef(new AbortController())
  const urls = useRef(new Set<string>())
  const itemsRef = useRef<GalleryItem[]>([])
  const secure = window.isSecureContext && !!crypto.subtle

  function revoke(url: string) { URL.revokeObjectURL(url); urls.current.delete(url) }
  function blobURL(bytes: Uint8Array, mime: string) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
    urls.current.add(url)
    return url
  }
  function current(version: number) { return alive.current && epoch.current === version }
  function check(version: number) { if (!current(version)) throw new DOMException('Cancelled', 'AbortError') }
  function replaceItems(next: GalleryItem[]) { itemsRef.current = next; setItems(next) }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
      controller.current.abort()
      urls.current.forEach((url) => URL.revokeObjectURL(url))
      urls.current.clear()
    }
  }, [])

  async function run(action: (signal: AbortSignal, version: number) => Promise<void>) {
    if (working.current) return
    // StrictMode cleanup may abort the initial controller before any user action.
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const version = epoch.current
    working.current = true
    setBusy(true); setError('')
    try { await action(controller.current.signal, version) }
    catch (error) { if (current(version)) setError(message(error)) }
    finally { if (current(version)) { working.current = false; setBusy(false); setProgress('') } }
  }

  function lock() {
    epoch.current++
    controller.current.abort()
    working.current = false
    urls.current.forEach((url) => URL.revokeObjectURL(url)); urls.current.clear()
    setSession(null); setConnection(null); replaceItems([]); setPreview(null)
    setCredential(''); setPassphrase(''); setConfirmation(''); setError(''); setProgress(''); setBusy(false)
    setSelectionVersion((value) => value + 1)
  }

  async function loadGallery(active: Session, signal: AbortSignal, version: number) {
    setProgress('Loading encrypted gallery…')
    const records = await active.client.list(active.config.id, signal)
    check(version)
    itemsRef.current.forEach((item) => { if (item.url) revoke(item.url) })
    replaceItems([])
    const next: GalleryItem[] = []
    for (const record of records) {
      let item: GalleryItem
      try {
        const signed = await active.client.downloadURL(record.id, 'thumbnail', signal)
        const thumbnail = await downloadCiphertext(signed, record.thumbnailSize, signal)
        const plain = await decryptPhotoThumbnail(active.key, active.config.id, record.id, {
          version: record.version, wrappedKey: fromBase64(record.wrappedKey), metadata: fromBase64(record.metadata), thumbnail,
        })
        check(version)
        item = { record, metadata: plain.metadata, url: blobURL(plain.thumbnail, 'image/png') }
      } catch (error) {
        check(version)
        item = { record, error: message(error) }
      }
      next.push(item)
      replaceItems([...next])
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault()
    const client = createGalleryClient(credential)
    setCredential('')
    void run(async (signal, version) => {
      setProgress('Checking API access…')
      const config = await client.getVault(signal)
      check(version)
      setConnection({ client, config })
    })
  }

  function unlock(event: FormEvent) {
    event.preventDefault()
    if (!connection) return
    const entered = passphrase
    const matches = entered === confirmation
    setPassphrase(''); setConfirmation('')
    void run(async (signal, version) => {
      setProgress('Deriving the vault key locally…')
      let active: Session
      if (connection.config) {
        const key = await unlockVault(entered, connection.config)
        active = { client: connection.client, config: connection.config, key }
      } else {
        if (!matches) throw new Error('The passphrases do not match.')
        const created = await createVault(entered)
        check(version)
        await connection.client.createVault(created.config, signal)
        active = { client: connection.client, ...created }
      }
      check(version)
      setSession(active)
      setConnection({ client: active.client, config: active.config })
      await loadGallery(active, signal, version)
    })
  }

  async function upload(files: File[]): Promise<File[]> {
    const uploaded: File[] = []
    if (!session) return uploaded
    const active = session
    await run(async (signal, version) => {
      for (const [index, file] of files.entries()) {
        const id = crypto.randomUUID()
        let hasIntent = false
        try {
          setProgress(`Encrypting photo ${index + 1} of ${files.length}…`)
          const encrypted = await encryptPhoto(active.key, active.config.id, id, file)
          check(version)
          const signed = await active.client.uploadIntent({
            id, version: 1, originalSize: encrypted.original.length, thumbnailSize: encrypted.thumbnail.length,
            wrappedKey: toBase64(encrypted.wrappedKey), metadata: toBase64(encrypted.metadata),
          }, signal)
          hasIntent = true
          setProgress(`Uploading encrypted original ${index + 1} of ${files.length}…`)
          await uploadCiphertext(signed.original, encrypted.original, signal)
          setProgress('Uploading encrypted thumbnail…')
          await uploadCiphertext(signed.thumbnail, encrypted.thumbnail, signal)
          setProgress('Verifying the uploaded ciphertext…')
          await active.client.confirm(id, signal)
          check(version)
          uploaded.push(file)
        } catch (error) {
          if (hasIntent && current(version)) {
            try { await active.client.delete(id, signal) }
            catch { if (current(version)) setError('Upload failed and cleanup could not finish. The operator may need to remove pending ciphertext.') }
          }
          check(version)
          setError((existing) => `${file.name}: ${message(error)}${existing ? ` ${existing}` : ''}`)
          break
        }
      }
      if (uploaded.length > 0) await loadGallery(active, signal, version)
    })
    return uploaded
  }

  function original(item: GalleryItem, download: boolean) {
    if (!session) return
    const active = session
    void run(async (signal, version) => {
      setProgress('Downloading and decrypting the original locally…')
      const signed = await active.client.downloadURL(item.record.id, 'original', signal)
      const encrypted = await downloadCiphertext(signed, item.record.originalSize, signal)
      const plain = await decryptPhotoOriginal(active.key, active.config.id, item.record.id, {
        version: item.record.version, wrappedKey: fromBase64(item.record.wrappedKey), metadata: fromBase64(item.record.metadata), original: encrypted,
      })
      check(version)
      const url = blobURL(plain.original, plain.metadata.mime)
      if (download) {
        const link = document.createElement('a')
        link.href = url; link.download = downloadName(plain.metadata.name)
        document.body.append(link); link.click(); link.remove()
        window.setTimeout(() => revoke(url), 1000)
      } else {
        if (preview) revoke(preview.url)
        setPreview({ id: item.record.id, name: plain.metadata.name, url })
      }
    })
  }

  function remove(item: GalleryItem) {
    if (!session || !window.confirm('Delete this encrypted photo and its thumbnail from storage?')) return
    const active = session
    void run(async (signal, version) => {
      setProgress('Deleting encrypted objects and metadata…')
      await active.client.delete(item.record.id, signal)
      check(version)
      if (item.url) revoke(item.url)
      replaceItems(itemsRef.current.filter((existing) => existing.record.id !== item.record.id))
      if (preview?.id === item.record.id) { revoke(preview.url); setPreview(null) }
    })
  }

  const field = 'mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm'
  return (
    <>
      <section aria-labelledby="vault-access-title" className="mb-8 rounded-2xl border border-stone-200 bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="vault-access-title" className="text-lg font-semibold">{session ? 'Vault unlocked on this device' : 'Open your vault'}</h2>
          {(connection || busy) && <button onClick={lock} className="rounded-lg border px-3 py-2 text-sm">Lock &amp; disconnect</button>}
        </div>
        <p className="mt-2 text-sm text-stone-600">Demo API access and vault encryption are separate. Passphrases and unwrapped keys stay in this browser. Losing your passphrase means losing access.</p>
        {!secure && <p role="alert" className="mt-4 text-sm text-red-800">Encryption requires localhost or trusted HTTPS. Do not use an HTTP EC2 IP.</p>}
        {!connection && <form onSubmit={connect} className="mt-5 max-w-lg">
          <label className="block text-sm font-medium">Demo API credential<input type="password" autoComplete="off" required minLength={32} maxLength={256} value={credential} onChange={(event) => setCredential(event.target.value)} disabled={busy} className={field} /></label>
          <button disabled={busy || !secure} className="mt-4 rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Connect API</button>
        </form>}
        {connection && !session && <form onSubmit={unlock} className="mt-5 max-w-lg">
          <p className="mb-4 text-sm text-stone-600">{connection.config ? 'An existing vault was found. Enter its exact passphrase to unlock.' : 'No vault exists yet. Create one with a strong, unique passphrase (12+ characters). There is no recovery or passphrase change in this lab version.'}</p>
          <label className="block text-sm font-medium">Vault passphrase<input type="password" autoComplete="off" required minLength={connection.config ? 1 : 12} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} disabled={busy} className={field} /></label>
          {!connection.config && <label className="mt-4 block text-sm font-medium">Confirm vault passphrase<input type="password" autoComplete="off" required minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} className={field} /></label>}
          <button disabled={busy || !secure} className="mt-4 rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{connection.config ? 'Unlock vault' : 'Create encrypted vault'}</button>
        </form>}
        <p role="status" className="mt-4 text-sm text-emerald-900">{progress || (session ? 'Keys are in memory only. Lock or close this page when finished.' : 'Vault locked.')}</p>
        {error && <p role="alert" className="mt-4 break-words rounded-lg bg-red-50 p-3 text-sm text-red-900">{error}</p>}
      </section>

      {session && <section aria-labelledby="encrypted-gallery-title" className="mb-10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div><h2 id="encrypted-gallery-title" className="text-xl font-semibold">Encrypted gallery</h2><p className="mt-1 text-xs text-stone-500">Showing up to 100 photos · Thumbnails decrypt locally</p></div>
          <button disabled={busy} onClick={() => { void run((signal, version) => loadGallery(session, signal, version)) }} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">Refresh gallery</button>
        </div>
        {items.length === 0 && !busy && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-stone-600">Your encrypted gallery is empty. Select a photo below to get started.</p>}
        <ul aria-label="Encrypted photos" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => <li key={item.record.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
            {item.url ? <img src={item.url} alt={item.metadata!.name} className="aspect-square w-full bg-stone-100 object-contain" /> : <div className="flex aspect-square items-center justify-center bg-stone-100 p-4 text-sm text-stone-600">Preview unavailable</div>}
            <div className="p-4">
              <h3 className="truncate text-sm font-semibold">{item.metadata?.name ?? 'Unreadable photo'}</h3>
              {item.error && <p role="alert" className="mt-2 text-xs text-red-800">{item.error}</p>}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button disabled={busy} onClick={() => original(item, false)} aria-label={`Preview ${item.metadata?.name ?? 'photo'}`} className="rounded border px-2 py-1 disabled:opacity-50">Preview</button>
                <button disabled={busy} onClick={() => original(item, true)} aria-label={`Download ${item.metadata?.name ?? 'photo'}`} className="rounded border px-2 py-1 disabled:opacity-50">Download</button>
                <button disabled={busy} onClick={() => remove(item)} aria-label={`Delete ${item.metadata?.name ?? 'photo'}`} className="rounded border px-2 py-1 text-red-800 disabled:opacity-50">Delete</button>
              </div>
            </div>
          </li>)}
        </ul>
      </section>}
      <PhotoSelection key={selectionVersion} onUpload={session ? upload : undefined} uploading={busy} />
      {preview && <OriginalPreview url={preview.url} name={preview.name} onClose={() => { revoke(preview.url); setPreview(null) }} />}
    </>
  )
}
