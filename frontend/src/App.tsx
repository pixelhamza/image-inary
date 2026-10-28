import { useEffect, useState } from 'react'
import { checkHealth } from './api/client'
import VaultGallery from './components/VaultGallery'

type APIStatus = 'checking' | 'online' | 'offline'

export default function App() {
  const [status, setStatus] = useState<APIStatus>('checking')
  const [attempt, setAttempt] = useState(0)
  const secureContext = window.isSecureContext && !!window.crypto?.subtle

  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5000)
    let active = true
    setStatus('checking')
    checkHealth(controller.signal)
      .then(() => { if (active) setStatus('online') })
      .catch(() => { if (active) setStatus('offline') })
      .finally(() => window.clearTimeout(timeout))
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [attempt])

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-5">
          <a href="/" className="flex items-center gap-3 text-xl font-bold tracking-tight">
            <span aria-hidden="true" className="rounded-xl bg-emerald-900 px-3 py-1.5 text-white">z.</span>
            Imageinary
          </a>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900">Lab demo · Not production authentication</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-9 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">Your private space</p>
            <h1 className="text-4xl font-semibold tracking-tight">Photo vault</h1>
            <p className="mt-3 text-stone-600">A quieter home for your photos. Built for privacy.</p>
          </div>
        </div>

        <VaultGallery />

        <section aria-labelledby="status-title" className="mt-8 rounded-2xl border border-stone-200 p-6">
          <h2 id="status-title" className="mb-4 text-sm font-semibold">Development checks</h2>
          <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
            <p role="status">
              API: <span className={status === 'online' ? 'font-medium text-emerald-800' : 'font-medium text-stone-600'}>
                {status === 'checking' ? 'Checking…' : status === 'online' ? 'Connected' : 'Unavailable — start the Go server on port 8080'}
              </span>
            </p>
            <button onClick={() => setAttempt((value) => value + 1)} disabled={status === 'checking'} className="rounded-lg border border-stone-300 px-3 py-1.5 font-medium hover:bg-white disabled:opacity-50">
              Check again
            </button>
          </div>
          <p className="mt-3 text-sm text-stone-600">
            Web Crypto: {secureContext ? 'Available in this secure context' : 'Unavailable — use localhost or trusted HTTPS'}
          </p>
        </section>
        <footer className="mt-8 text-center text-xs text-stone-500">Imageinary · AWS lab project · Development build, not a production vault</footer>
      </main>
    </div>
  )
}
