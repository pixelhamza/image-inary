import { assertID } from '../crypto/envelope'
import { validateVaultConfig, type VaultConfig } from '../crypto/vault'

export type MediaRecord = {
  id: string; vaultId: string; version: 1; originalSize: number; thumbnailSize: number
  wrappedKey: string; metadata: string; status: 'ready'; createdAt: string
}
export type TransferURL = { url: string; headers: Record<string, string>; expiresAt: string }
export type UploadIntent = {
  id: string; version: 1; originalSize: number; thumbnailSize: number; wrappedKey: string; metadata: string
}

export class APIError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

const messages: Record<number, string> = {
  400: 'The request or encrypted record is invalid.',
  401: 'API access denied. Lock the vault and reconnect with the operator credential.',
  404: 'The vault or photo no longer exists. Refresh the gallery.',
  409: 'The vault already exists, or the upload could not be verified. Refresh and retry.',
  413: 'The encrypted metadata request is too large.',
  503: 'The API, database, or storage is unavailable. Check the server configuration and retry.',
}

// This client receives only the demo access credential and public/ciphertext
// records. It never receives vault passphrases, CryptoKeys, or plaintext files.
export function createGalleryClient(credential: string) {
  async function request(path: string, method: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`/api${path}`, {
        method, headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      })
    } catch {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      throw new Error('Cannot reach the API. Check the connection and retry.')
    }
    if (!response.ok) throw new APIError(response.status, messages[response.status] ?? 'The API request failed. Retry later.')
    if (response.status === 204) return undefined
    const bytes = await readBounded(response, 4 * 1024 * 1024)
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
    catch { throw new Error('The API returned invalid JSON.') }
  }

  return {
    async getVault(signal: AbortSignal): Promise<VaultConfig | null> {
      try {
        const config = await request('/vault', 'GET', undefined, signal)
        validateVaultConfig(config)
        return config
      } catch (error) {
        if (error instanceof APIError && error.status === 404) return null
        throw error
      }
    },
    async createVault(config: VaultConfig, signal: AbortSignal) {
      validateVaultConfig(config)
      let saved: unknown
      try { saved = await request('/vault', 'POST', config, signal) }
      catch (error) {
        if (error instanceof APIError && error.status === 409) {
          throw new APIError(409, 'Another browser initialized the vault. Lock & disconnect, reconnect, and unlock the existing vault; do not overwrite it.')
        }
        throw error
      }
      validateVaultConfig(saved)
      // Never silently replace the locally created vault with another config.
      if (saved.id !== config.id || saved.version !== config.version || saved.verifier !== config.verifier ||
        saved.kdf.name !== config.kdf.name || saved.kdf.hash !== config.kdf.hash ||
        saved.kdf.iterations !== config.kdf.iterations || saved.kdf.salt !== config.kdf.salt) {
        throw new Error('The saved vault configuration does not match. Reconnect before continuing.')
      }
    },
    async list(vaultId: string, signal: AbortSignal): Promise<MediaRecord[]> {
      const result = await request('/media?limit=100', 'GET', undefined, signal)
      if (!result || typeof result !== 'object' || !('media' in result) || !Array.isArray(result.media) || result.media.length > 100) {
        throw new Error('Invalid gallery response.')
      }
      const ids = new Set<string>()
      for (const item of result.media) {
        if (!item || typeof item !== 'object') throw new Error('Invalid gallery record.')
        assertID(item.id)
        if (item.vaultId !== vaultId || item.version !== 1 || item.status !== 'ready' ||
          !Number.isSafeInteger(item.originalSize) || item.originalSize < 30 || item.originalSize > 20 * 1024 * 1024 + 29 ||
          !Number.isSafeInteger(item.thumbnailSize) || item.thumbnailSize < 30 || item.thumbnailSize > 1024 * 1024 + 29 ||
          typeof item.wrappedKey !== 'string' || item.wrappedKey.length !== 84 ||
          typeof item.metadata !== 'string' || item.metadata.length > 22_000 || ids.has(item.id)) throw new Error('Invalid gallery record.')
        ids.add(item.id)
      }
      return result.media as MediaRecord[]
    },
    async uploadIntent(input: UploadIntent, signal: AbortSignal): Promise<{ original: TransferURL; thumbnail: TransferURL }> {
      const result = await request('/media/upload-url', 'POST', input, signal)
      if (!result || typeof result !== 'object' || !('id' in result) || result.id !== input.id || !('original' in result) || !('thumbnail' in result)) {
        throw new Error('Invalid upload authorization response.')
      }
      return { original: validateTransferURL(result.original), thumbnail: validateTransferURL(result.thumbnail) }
    },
    async confirm(id: string, signal: AbortSignal) { assertID(id); await request('/media', 'POST', { id }, signal) },
    async downloadURL(id: string, variant: 'original' | 'thumbnail', signal: AbortSignal): Promise<TransferURL> {
      assertID(id)
      return validateTransferURL(await request(`/media/${id}/download-url?variant=${variant}`, 'GET', undefined, signal))
    },
    async delete(id: string, signal: AbortSignal) { assertID(id); await request(`/media/${id}`, 'DELETE', undefined, signal) },
  }
}

export function validateTransferURL(value: unknown): TransferURL {
  if (!value || typeof value !== 'object') throw new Error('Invalid transfer authorization.')
  const data = value as Partial<TransferURL>
  if (typeof data.url !== 'string' || data.url.length > 16_384 || typeof data.expiresAt !== 'string') throw new Error('Invalid transfer authorization.')
  let url: URL
  try { url = new URL(data.url) } catch { throw new Error('Invalid transfer URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Transfer URLs must use HTTPS without embedded credentials.')
  const expires = Date.parse(data.expiresAt)
  if (!Number.isFinite(expires) || expires > Date.now() + 5 * 60_000) throw new Error('Invalid transfer expiration.')
  if (expires <= Date.now()) throw new Error('The transfer link expired. Retry to obtain a new link.')
  const headers: Record<string, string> = {}
  if (data.headers != null) {
    if (typeof data.headers !== 'object' || Array.isArray(data.headers) || Object.keys(data.headers).length > 16) throw new Error('Invalid transfer headers.')
    for (const [name, value] of Object.entries(data.headers)) {
      if (!/^(content-type|x-amz-[a-z0-9-]+)$/i.test(name) || typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) throw new Error('Unsafe transfer headers.')
      headers[name.toLowerCase()] = value
    }
  }
  return { url: data.url, headers, expiresAt: data.expiresAt }
}

export async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const advertised = response.headers.get('content-length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) {
    await response.body?.cancel()
    throw new Error('Response exceeds the expected size limit.')
  }
  if (!response.body) throw new Error('Response body is missing.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); throw new Error('Response exceeds the expected size limit.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function transfer(signed: TransferURL, method: 'GET' | 'PUT', signal: AbortSignal, bytes?: Uint8Array): Promise<Response> {
  const safe = validateTransferURL(signed)
  let response: Response
  try {
    response = await fetch(safe.url, {
      method, headers: { ...safe.headers, ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}) },
      body: bytes ? new Uint8Array(bytes) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    throw new Error('Ciphertext transfer failed. Check the network, S3 CORS, and frontend origin, then retry.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 403 || response.status === 401) throw new Error('Transfer access denied or link expired. Retry to obtain a new link.')
    if (response.status === 404) throw new Error('The encrypted object is missing. Refresh or ask the operator to check storage.')
    throw new Error('Ciphertext storage is unavailable. Retry later.')
  }
  return response
}

export async function uploadCiphertext(signed: TransferURL, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  await (await transfer(signed, 'PUT', signal, bytes)).body?.cancel()
}

export async function downloadCiphertext(signed: TransferURL, expectedSize: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 30 || expectedSize > 20 * 1024 * 1024 + 29) throw new Error('Invalid expected ciphertext size.')
  const bytes = await readBounded(await transfer(signed, 'GET', signal), expectedSize)
  if (bytes.length !== expectedSize) throw new Error('The encrypted object is incomplete or has changed.')
  return bytes
}
