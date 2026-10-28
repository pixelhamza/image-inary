import { randomUUID } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import type { MediaRecord, UploadIntent } from '../src/api/gallery'
import type { VaultConfig } from '../src/crypto/vault'

export const operatorCredential = 'synthetic-browser-test-api-credential-123456789'
export const vaultPassphrase = 'synthetic browser vault passphrase 123'
type StoredMedia = Omit<MediaRecord, 'status'> & { status: 'pending' | 'ready'; originalKey: string; thumbnailKey: string }

// Browser/UI integration fixture only. It emulates API/storage responses and
// retains only public config and ciphertext. It is NOT an S3/CORS/IAM proof.
export class GalleryFixture {
  vault: VaultConfig | null = null
  media = new Map<string, StoredMedia>()
  objects = new Map<string, Buffer>()
  apiBodies: unknown[] = []
  storageHeaders: Record<string, string>[] = []
  failPut = false
  readFailure: { variant: 'original' | 'thumbnail'; status: number } | null = null
  corrupt: 'original' | 'thumbnail' | null = null
  apiUnavailable = false
  delayVault = 0
  private grants = new Map<string, { key: string; method: 'GET' | 'PUT'; size: number }>()

  private sign(key: string, method: 'GET' | 'PUT', size: number) {
    const grant = randomUUID()
    this.grants.set(grant, { key, method, size })
    return { url: `https://ciphertext.example/${key}?grant=${grant}`, headers: method === 'PUT' ? { 'Content-Type': 'application/octet-stream' } : {}, expiresAt: new Date(Date.now() + 180_000).toISOString() }
  }

  async install(context: BrowserContext) {
    await context.route('**/healthz', (route) => route.fulfill({ json: { status: 'ok' } }))
    await context.route('http://localhost:5179/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const method = request.method()
      if (request.headers().authorization !== `Bearer ${operatorCredential}`) { await route.fulfill({ status: 401, json: { error: 'unauthorized' } }); return }
      if (this.apiUnavailable) { await route.fulfill({ status: 503, json: { error: 'database_unavailable' } }); return }
      const body = request.postData() ? request.postDataJSON() : undefined
      if (body) this.apiBodies.push(body)
      if (path === '/api/vault') {
        if (this.delayVault) await new Promise((resolve) => setTimeout(resolve, this.delayVault))
        if (method === 'GET') { await route.fulfill({ status: this.vault ? 200 : 404, json: this.vault ?? { error: 'not_found' } }).catch(() => {}); return }
        if (this.vault) { await route.fulfill({ status: 409, json: { error: 'conflict' } }); return }
        this.vault = body as VaultConfig
        await route.fulfill({ status: 201, json: this.vault }); return
      }
      if (path === '/api/media/upload-url') {
        const input = body as UploadIntent
        const originalKey = randomUUID(), thumbnailKey = randomUUID()
        const record: StoredMedia = { ...input, vaultId: this.vault!.id, status: 'pending', createdAt: new Date().toISOString(), originalKey, thumbnailKey }
        this.media.set(input.id, record)
        await route.fulfill({ status: 201, json: { id: input.id, original: this.sign(originalKey, 'PUT', input.originalSize), thumbnail: this.sign(thumbnailKey, 'PUT', input.thumbnailSize) } }); return
      }
      if (path === '/api/media' && method === 'GET') {
        const media = [...this.media.values()].filter((item) => item.status === 'ready').map(({ originalKey: _original, thumbnailKey: _thumbnail, ...record }) => record)
        await route.fulfill({ json: { media } }); return
      }
      if (path === '/api/media' && method === 'POST') {
        const record = this.media.get(body.id)
        if (!record || this.objects.get(record.originalKey)?.length !== record.originalSize || this.objects.get(record.thumbnailKey)?.length !== record.thumbnailSize) {
          await route.fulfill({ status: 409, json: { error: 'upload_not_verified' } }); return
        }
        record.status = 'ready'
        const { originalKey: _original, thumbnailKey: _thumbnail, ...result } = record
        await route.fulfill({ json: result }); return
      }
      const match = path.match(/^\/api\/media\/([^/]+)(\/download-url)?$/)
      if (match) {
        const record = this.media.get(match[1])
        if (method === 'DELETE') {
          if (record) { this.objects.delete(record.originalKey); this.objects.delete(record.thumbnailKey); this.media.delete(record.id) }
          await route.fulfill({ status: 204 }); return
        }
        if (!record || record.status !== 'ready') { await route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
        const variant = new URL(request.url()).searchParams.get('variant')
        await route.fulfill({ json: this.sign(variant === 'thumbnail' ? record.thumbnailKey : record.originalKey, 'GET', variant === 'thumbnail' ? record.thumbnailSize : record.originalSize) }); return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    })
    await context.route('https://ciphertext.example/**', async (route) => {
      const request = route.request()
      const headers = { 'Access-Control-Allow-Origin': 'http://localhost:5179', 'Access-Control-Allow-Methods': 'PUT,GET,HEAD', 'Access-Control-Allow-Headers': 'content-type', 'Content-Type': 'application/octet-stream' }
      if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
      this.storageHeaders.push(request.headers())
      const grant = this.grants.get(new URL(request.url()).searchParams.get('grant') ?? '')
      if (!grant || request.method() !== grant.method) { await route.fulfill({ status: 403, headers }); return }
      if (grant.method === 'PUT') {
        if (this.failPut) { await route.fulfill({ status: 503, headers }); return }
        const bytes = request.postDataBuffer()
        if (!bytes || bytes.length !== grant.size) { await route.fulfill({ status: 403, headers }); return }
        this.objects.set(grant.key, bytes)
        await route.fulfill({ status: 200, headers }); return
      }
      const original = [...this.media.values()].some((record) => record.originalKey === grant.key)
      const variant = original ? 'original' : 'thumbnail'
      if (this.readFailure?.variant === variant) { await route.fulfill({ status: this.readFailure.status, headers }); return }
      const bytes = this.objects.get(grant.key)
      if (!bytes) { await route.fulfill({ status: 404, headers }); return }
      const copy = Buffer.from(bytes)
      if (this.corrupt === variant) copy[copy.length - 1] ^= 1
      await route.fulfill({ status: 200, headers, body: copy })
    })
  }
}
