import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkHealth } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('checkHealth', () => {
  it('accepts a healthy API response and forwards cancellation', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'ok' }))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await expect(checkHealth(signal)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith('/healthz', { signal, cache: 'no-store' })
  })

  it('rejects an unsuccessful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    await expect(checkHealth()).rejects.toThrow('API is unavailable')
  })

  it.each([null, {}, { status: 'error' }, 'ok'])(
    'rejects malformed health data: %j', async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
      await expect(checkHealth()).rejects.toThrow('Unexpected health response')
    },
  )

  it('propagates connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(checkHealth()).rejects.toThrow('Failed to fetch')
  })
})
