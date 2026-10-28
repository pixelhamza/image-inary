import { chromium, expect, test } from '@playwright/test'
import { animatedGIF, generatedPhoto } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.route('**/healthz', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ status: 'ok' }),
  }))
  await page.goto('/')
})

for (const extension of ['png', 'jpg', 'jpeg', 'gif']) {
  test(`encrypts and decrypts real ${extension} bytes, thumbnail, and private metadata`, async ({ page }) => {
    const mime = extension === 'gif' ? 'image/gif' : extension === 'png' ? 'image/png' : 'image/jpeg'
    const buffer = mime === 'image/gif' ? animatedGIF() : await generatedPhoto(page, mime)
    const result = await page.evaluate(async ({ bytes, mime, name }) => {
      const vaultModule = '/src/crypto/vault.ts'
      const photoModule = '/src/crypto/photo.ts'
      const { createVault } = await import(vaultModule)
      const { encryptPhoto, decryptPhoto } = await import(photoModule)
      const { config, key } = await createVault('synthetic browser test passphrase')
      const mediaId = crypto.randomUUID()
      const file = new File([new Uint8Array(bytes)], name, { type: mime, lastModified: 1234 })
      const record = await encryptPhoto(key, config.id, mediaId, file)
      const decrypted = await decryptPhoto(key, config.id, mediaId, record)
      const thumbnail = await createImageBitmap(new Blob([new Uint8Array(decrypted.thumbnail)], { type: 'image/png' }))
      const dimensions = { width: thumbnail.width, height: thumbnail.height }
      thumbnail.close()
      return {
        secure: window.isSecureContext && !!crypto.subtle,
        original: Array.from(decrypted.original as Uint8Array),
        metadata: decrypted.metadata, dimensions,
        fields: Object.keys(record),
        metadataExposed: new TextDecoder().decode(record.metadata).includes(name),
        originalEncrypted: Array.from(record.original as Uint8Array).join(',') !== bytes.join(','),
      }
    }, { bytes: Array.from(buffer), mime, name: `private-name.${extension}` })
    expect(result.secure).toBe(true)
    expect(Buffer.from(result.original)).toEqual(buffer)
    expect(result.metadata).toMatchObject({ name: `private-name.${extension}`, mime, size: buffer.length, lastModified: 1234 })
    expect(result.dimensions.width).toBeGreaterThan(0)
    expect(result.dimensions.width).toBeLessThanOrEqual(320)
    expect(result.dimensions.height).toBeLessThanOrEqual(320)
    expect(result.fields.sort()).toEqual(['metadata', 'original', 'thumbnail', 'version', 'wrappedKey'])
    expect(result.metadataExposed).toBe(false)
    expect(result.originalEncrypted).toBe(true)
  })
}

test('recovers in an independent browser/context using only public config and ciphertext', async ({ page, browser }, info) => {
  const bytes = Array.from(animatedGIF())
  const transfer = await page.evaluate(async (bytes) => {
    const vaultModule = '/src/crypto/vault.ts'
    const photoModule = '/src/crypto/photo.ts'
    const { createVault } = await import(vaultModule)
    const { encryptPhoto } = await import(photoModule)
    const { config, key } = await createVault('synthetic browser recovery passphrase')
    const mediaId = crypto.randomUUID()
    const record = await encryptPhoto(key, config.id, mediaId, new File([new Uint8Array(bytes)], 'original.gif', { type: 'image/gif' }))
    return {
      config: JSON.parse(JSON.stringify(config)), mediaId,
      record: {
        version: 1, wrappedKey: Array.from(record.wrappedKey as Uint8Array),
        original: Array.from(record.original as Uint8Array), thumbnail: Array.from(record.thumbnail as Uint8Array),
        metadata: Array.from(record.metadata as Uint8Array),
      },
    }
  }, bytes)
  // Optionally prove recovery in another installed Chromium browser (e.g. Edge).
  const recoveryPath = process.env.PLAYWRIGHT_RECOVERY_EXECUTABLE_PATH
  const recoveryBrowser = recoveryPath ? await chromium.launch({ executablePath: recoveryPath }) : undefined
  const secondContext = await (recoveryBrowser ?? browser).newContext()
  info.annotations.push({ type: 'Recovery environment', description: recoveryPath ? 'Separate installed browser process' : 'Independent browser context' })
  try {
    const secondPage = await secondContext.newPage()
    await secondPage.route('**/healthz', (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ status: 'ok' }),
    }))
    await secondPage.goto(page.url())
    const recovered = await secondPage.evaluate(async (transfer) => {
      const vaultModule = '/src/crypto/vault.ts'
      const photoModule = '/src/crypto/photo.ts'
      const { unlockVault } = await import(vaultModule)
      const { decryptPhoto } = await import(photoModule)
      const key = await unlockVault('synthetic browser recovery passphrase', transfer.config)
      const photo = {
        version: 1, wrappedKey: new Uint8Array(transfer.record.wrappedKey),
        original: new Uint8Array(transfer.record.original), thumbnail: new Uint8Array(transfer.record.thumbnail),
        metadata: new Uint8Array(transfer.record.metadata),
      }
      const decrypted = await decryptPhoto(key, transfer.config.id, transfer.mediaId, photo)
      return Array.from(decrypted.original as Uint8Array)
    }, transfer)
    expect(recovered).toEqual(bytes)
  } finally {
    await secondContext.close()
    await recoveryBrowser?.close()
  }
})

test('rejects wrong passwords and tampering in browser Web Crypto', async ({ page }) => {
  const bytes = Array.from(animatedGIF())
  const result = await page.evaluate(async (bytes) => {
    const vaultModule = '/src/crypto/vault.ts'
    const photoModule = '/src/crypto/photo.ts'
    const { createVault, unlockVault } = await import(vaultModule)
    const { encryptPhoto, decryptPhoto } = await import(photoModule)
    const { config, key } = await createVault('synthetic browser test passphrase')
    const mediaId = crypto.randomUUID()
    const record = await encryptPhoto(key, config.id, mediaId, new File([new Uint8Array(bytes)], 'test.gif', { type: 'image/gif' }))
    const rejected = async (action: () => Promise<unknown>) => {
      try { await action(); return false } catch { return true }
    }
    const wrongPassphrase = await rejected(() => unlockVault('wrong browser test passphrase', config))
    const wrongId = await rejected(() => decryptPhoto(key, config.id, crypto.randomUUID(), record))
    record.original[record.original.length - 1] ^= 1
    const tampered = await rejected(() => decryptPhoto(key, config.id, mediaId, record))
    return { wrongPassphrase, wrongId, tampered }
  }, bytes)
  expect(result).toEqual({ wrongPassphrase: true, wrongId: true, tampered: true })
})

test('PBKDF2 leaves the browser event loop responsive at 600,000 iterations', async ({ page }, info) => {
  const measurement = await page.evaluate(async () => {
    const vaultModule = '/src/crypto/vault.ts'
    const { createVault } = await import(vaultModule)
    let ticks = 0
    const timer = window.setInterval(() => { ticks++ }, 5)
    const start = performance.now()
    try {
      await createVault('synthetic responsiveness test passphrase')
      return { ticks, milliseconds: Math.round(performance.now() - start) }
    } finally { clearInterval(timer) }
  })
  expect(measurement.ticks).toBeGreaterThan(0)
  info.annotations.push({ type: 'PBKDF2 duration', description: `${measurement.milliseconds} ms on this test device; ${measurement.ticks} event-loop ticks` })
})
