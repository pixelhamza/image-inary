import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError, createGalleryClient, downloadCiphertext, readBounded, uploadCiphertext, validateTransferURL } from './gallery'

const credential = 'synthetic-unit-test-credential-not-a-real-token'
const signal = () => new AbortController().signal
const signed = () => ({ url: 'https://ciphertext.example/object?signature=synthetic', headers: {}, expiresAt: new Date(Date.now() + 180_000).toISOString() })
afterEach(() => vi.unstubAllGlobals())

describe('credential and transfer boundaries', () => {
  it('sends the operator credential only to same-origin API requests', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createGalleryClient(credential).getVault(signal())).rejects.toBeInstanceOf(APIError)
    expect(fetch.mock.calls[0][0]).toBe('/api/vault')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${credential}`)
    expect(fetch.mock.calls[0][1].redirect).toBe('error')
  })

  it('never forwards API credentials or cookies to ciphertext storage', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await uploadCiphertext({ ...signed(), headers: { 'Content-Type': 'application/octet-stream' } }, new Uint8Array(30), signal())
    const options = fetch.mock.calls[0][1]
    expect(options.credentials).toBe('omit')
    expect(options.referrerPolicy).toBe('no-referrer')
    expect(options.redirect).toBe('error')
    expect(options.headers).toEqual({ 'content-type': 'application/octet-stream' })
    expect(options.body).toBeInstanceOf(Uint8Array)
  })

  it.each(['Authorization', 'Cookie', 'Host', 'Content-Length', 'X-API-Key'])('rejects unsafe signed headers: %s', (name) => {
    expect(() => validateTransferURL({ ...signed(), headers: { [name]: 'unsafe' } })).toThrow('Unsafe transfer headers')
  })

  it.each(['http://ciphertext.example/key', 'https://user:secret@ciphertext.example/key', 'javascript:alert(1)'])('rejects unsafe transfer URL %s', (url) => {
    expect(() => validateTransferURL({ ...signed(), url })).toThrow()
  })

  it('rejects expired URLs without making a network request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(uploadCiphertext({ ...signed(), expiresAt: new Date(Date.now() - 1000).toISOString() }, new Uint8Array(30), signal())).rejects.toThrow('expired')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds transfer link lifetime and disallows header injection', () => {
    expect(() => validateTransferURL({ ...signed(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })).toThrow('expiration')
    expect(() => validateTransferURL({ ...signed(), headers: { 'x-amz-test': 'value\r\nInjected: yes' } })).toThrow('Unsafe')
  })
})

describe('failure reporting and bounded downloads', () => {
  it.each([[403, 'expired'], [404, 'missing'], [500, 'unavailable']])('handles storage status %i', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive signed URL must not be displayed', { status: status as number })))
    await expect(downloadCiphertext(signed(), 30, signal())).rejects.toThrow(expected as string)
  })

  it('reports network/CORS failures without exposing signed URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('https://sensitive-signed-url')))
    await expect(uploadCiphertext(signed(), new Uint8Array(30), signal())).rejects.toThrow('S3 CORS')
  })

  it('rejects truncated ciphertext', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(29))))
    await expect(downloadCiphertext(signed(), 30, signal())).rejects.toThrow('incomplete')
  })

  it('rejects oversized content length before buffering', async () => {
    await expect(readBounded(new Response(new Uint8Array(5), { headers: { 'Content-Length': '1000' } }), 10)).rejects.toThrow('size limit')
  })

  it('bounds streamed bodies even without a content-length header', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); controller.close() } })
    await expect(readBounded(new Response(stream), 10)).rejects.toThrow('size limit')
  })

  it('reports API/database failure without reflecting the response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret connection string', { status: 503 })))
    await expect(createGalleryClient(credential).getVault(signal())).rejects.toThrow('server configuration')
  })

  it('maps a missing vault to creation mode, but does not hide authorization failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    await expect(createGalleryClient(credential).getVault(signal())).resolves.toBeNull()
  })

  it('reports concurrent vault initialization without overwriting existing configuration', async () => {
    const bytes = new Uint8Array(53); bytes[0] = 1
    const config = {
      version: 1 as const, id: '11111111-1111-4111-8111-111111111111',
      kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: 600_000, salt: btoa('\0'.repeat(16)) },
      verifier: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
    }
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createGalleryClient(credential).createVault(config, signal())).rejects.toThrow('do not overwrite')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects malformed and oversized API responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')))
    await expect(createGalleryClient(credential).getVault(signal())).rejects.toThrow('invalid JSON')
  })

  it('rejects cancellation without treating it as a server error', async () => {
    const controller = new AbortController(); controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')))
    await expect(createGalleryClient(credential).getVault(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
