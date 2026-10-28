import { expect, test, type Page } from '@playwright/test'
import { animatedGIF, generatedPhoto } from './fixtures'
import { GalleryFixture, operatorCredential, vaultPassphrase } from './gallery-fixture'

async function connect(page: Page) {
  await page.getByLabel('Demo API credential', { exact: true }).fill(operatorCredential)
  await page.getByRole('button', { name: 'Connect API', exact: true }).click()
  await expect(page.getByLabel('Vault passphrase', { exact: true })).toBeVisible()
}

async function create(page: Page) {
  await connect(page)
  await page.getByLabel('Vault passphrase', { exact: true }).fill(vaultPassphrase)
  await page.getByLabel('Confirm vault passphrase', { exact: true }).fill(vaultPassphrase)
  await page.getByRole('button', { name: 'Create encrypted vault', exact: true }).click()
  await expect(page.getByText('Your encrypted gallery is empty.', { exact: false })).toBeVisible()
}

async function selectAndUpload(page: Page, name = 'animated.gif') {
  await page.getByLabel('Choose photos').setInputFiles({ name, mimeType: 'image/gif', buffer: animatedGIF() })
  await expect(page.getByText('1 photo selected locally')).toBeVisible()
  await page.getByRole('button', { name: 'Encrypt & upload selected', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Encrypted photos' }).getByRole('heading', { name, exact: true })).toBeVisible()
}

test('full encrypted UI workflow, second-context recovery, GIF download, preview, deletion, and lock', async ({ page, context, browser }) => {
  const fixture = new GalleryFixture()
  await fixture.install(context)
  await context.addInitScript(() => {
    const live = new Set<string>()
    ;(window as unknown as { testLiveBlobURLs: Set<string> }).testLiveBlobURLs = live
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (blob) => { const url = create(blob); live.add(url); return url }
    URL.revokeObjectURL = (url) => { live.delete(url); revoke(url) }
  })
  await page.goto('/')
  await create(page)
  const png = await generatedPhoto(page, 'image/png')
  const jpeg = await generatedPhoto(page, 'image/jpeg')
  const gif = animatedGIF()
  await page.getByLabel('Choose photos').setInputFiles([
    { name: 'private.png', mimeType: 'image/png', buffer: png },
    { name: 'private.jpeg', mimeType: 'image/jpeg', buffer: jpeg },
    { name: 'animated.gif', mimeType: 'image/gif', buffer: gif },
  ])
  await expect(page.getByText('3 photos selected locally')).toBeVisible()
  await page.getByRole('button', { name: 'Encrypt & upload selected', exact: true }).click()
  const gallery = page.getByRole('list', { name: 'Encrypted photos' })
  await expect(gallery.getByRole('img')).toHaveCount(3)
  await expect(page.getByText('0 photos selected locally')).toBeVisible()
  expect(fixture.media.size).toBe(3)
  expect(fixture.objects.size).toBe(6)
  for (const record of fixture.media.values()) {
    expect(record.status).toBe('ready')
    const original = fixture.objects.get(record.originalKey)!
    expect(original[0]).toBe(1)
    expect([png, jpeg, gif].some((plain) => plain.equals(original))).toBe(false)
  }
  const sent = JSON.stringify(fixture.apiBodies)
  expect(sent).not.toContain(vaultPassphrase)
  for (const name of ['private.png', 'private.jpeg', 'animated.gif']) expect(sent).not.toContain(name)
  expect(fixture.storageHeaders.every((headers) => !headers.authorization && !headers.cookie && !headers.referer)).toBe(true)

  await gallery.getByRole('button', { name: 'Preview animated.gif', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const displayed = await dialog.getByRole('img').evaluate(async (image: HTMLImageElement) => {
    await image.decode()
    return Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer()))
  })
  expect(Buffer.from(displayed)).toEqual(gif)
  await page.getByRole('button', { name: 'Close preview' }).click()
  const event = page.waitForEvent('download')
  await gallery.getByRole('button', { name: 'Download animated.gif', exact: true }).click()
  const download = await event
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks)).toEqual(gif)
  expect(download.suggestedFilename()).toBe('animated.gif')

  const secondContext = await browser.newContext()
  try {
    await fixture.install(secondContext)
    const second = await secondContext.newPage()
    await second.goto(page.url())
    await connect(second)
    await second.getByLabel('Vault passphrase', { exact: true }).fill(vaultPassphrase)
    await second.getByRole('button', { name: 'Unlock vault', exact: true }).click()
    await expect(second.getByRole('list', { name: 'Encrypted photos' }).getByRole('img')).toHaveCount(3)
  } finally { await secondContext.close() }

  page.once('dialog', (dialog) => dialog.accept())
  await gallery.getByRole('button', { name: 'Delete private.jpeg', exact: true }).click()
  await expect(gallery.getByRole('img')).toHaveCount(2)
  expect(fixture.objects.size).toBe(4)
  await page.getByRole('button', { name: 'Lock & disconnect', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Encrypted photos' })).toHaveCount(0)
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 })
  expect(await page.evaluate(() => (window as unknown as { testLiveBlobURLs: Set<string> }).testLiveBlobURLs.size)).toBe(0)
})

test('wrong API credential and wrong vault passphrase fail without overwriting the vault', async ({ page, context }) => {
  const fixture = new GalleryFixture(); await fixture.install(context); await page.goto('/')
  await page.getByLabel('Demo API credential').fill('deliberately-wrong-browser-api-credential-123456789')
  await page.getByRole('button', { name: 'Connect API', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('API access denied')
  await create(page)
  const before = JSON.stringify(fixture.vault)
  await page.getByRole('button', { name: 'Lock & disconnect', exact: true }).click()
  await connect(page)
  await page.getByLabel('Vault passphrase', { exact: true }).fill('deliberately wrong vault passphrase')
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unable to decrypt')
  expect(JSON.stringify(fixture.vault)).toBe(before)
  await expect(page.getByRole('list', { name: 'Encrypted photos' })).toHaveCount(0)
})

test('failed upload cleans up pending records and retries with a new media identity', async ({ page, context }) => {
  const fixture = new GalleryFixture(); await fixture.install(context); await page.goto('/'); await create(page)
  fixture.failPut = true
  await page.getByLabel('Choose photos').setInputFiles({ name: 'retry.gif', mimeType: 'image/gif', buffer: animatedGIF() })
  await page.getByRole('button', { name: 'Encrypt & upload selected', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('storage is unavailable')
  expect(fixture.media.size).toBe(0)
  expect(fixture.objects.size).toBe(0)
  const firstIntent = fixture.apiBodies.find((body) => body && typeof body === 'object' && 'originalSize' in body) as { id: string }
  fixture.failPut = false
  await page.getByRole('button', { name: 'Encrypt & upload selected', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Encrypted photos' }).getByRole('img')).toHaveCount(1)
  expect([...fixture.media.keys()][0]).not.toBe(firstIntent.id)
})

test('expired links, missing objects, and tampered thumbnails remain visible as errors and can recover', async ({ page, context }) => {
  const fixture = new GalleryFixture(); await fixture.install(context); await page.goto('/'); await create(page)
  await selectAndUpload(page)
  const gallery = page.getByRole('list', { name: 'Encrypted photos' })
  for (const status of [403, 404]) {
    fixture.readFailure = { variant: 'thumbnail', status }
    await page.getByRole('button', { name: 'Refresh gallery' }).click()
    await expect(gallery.getByRole('alert')).toContainText(status === 403 ? 'expired' : 'missing')
    await expect(gallery.getByRole('img')).toHaveCount(0)
  }
  fixture.readFailure = null; fixture.corrupt = 'thumbnail'
  await page.getByRole('button', { name: 'Refresh gallery' }).click()
  await expect(gallery.getByRole('alert')).toContainText('Unable to decrypt')
  fixture.corrupt = null
  await page.getByRole('button', { name: 'Refresh gallery' }).click()
  await expect(gallery.getByRole('img')).toHaveCount(1)
  fixture.corrupt = 'original'
  await gallery.getByRole('button', { name: 'Preview animated.gif', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unable to decrypt')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('database/API outages are actionable and lock cancels an in-flight connection', async ({ page, context }) => {
  const fixture = new GalleryFixture(); await fixture.install(context); await page.goto('/')
  fixture.apiUnavailable = true
  await page.getByLabel('Demo API credential').fill(operatorCredential)
  await page.getByRole('button', { name: 'Connect API', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('server configuration')
  fixture.apiUnavailable = false; fixture.delayVault = 1000
  await page.getByLabel('Demo API credential').fill(operatorCredential)
  await page.getByRole('button', { name: 'Connect API', exact: true }).click()
  await page.getByRole('button', { name: 'Lock & disconnect', exact: true }).click()
  await expect(page.getByLabel('Demo API credential')).toBeVisible()
  await expect(page.getByLabel('Vault passphrase', { exact: true })).toHaveCount(0)
  await page.waitForTimeout(1100)
  await expect(page.getByLabel('Vault passphrase', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
