import { expect, test } from '@playwright/test'
import { animatedGIF, generatedPhoto } from './fixtures'

test.beforeEach(async ({ page }) => {
  // Selection must work without a running backend or AWS account.
  await page.route('**/healthz', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ status: 'ok' }),
  }))
  await page.goto('/')
})

for (const extension of ['png', 'jpg', 'jpeg', 'gif']) {
  test(`previews and removes ${extension} without uploading or changing its bytes`, async ({ page }) => {
    const uploads: string[] = []
    page.on('request', (request) => {
      if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url())
    })
    const mime = extension === 'gif' ? 'image/gif' : extension === 'png' ? 'image/png' : 'image/jpeg'
    const buffer = mime === 'image/gif' ? animatedGIF() : await generatedPhoto(page, mime)
    const name = `sample.${extension}`
    await page.getByLabel('Choose photos').setInputFiles({ name, mimeType: mime, buffer })
    await expect(page.getByText('1 photo selected locally')).toBeVisible()
    const image = page.getByRole('img', { name, exact: true })
    await expect(image).toBeVisible()
    const preview = await image.evaluate(async (element: HTMLImageElement) => {
      await element.decode()
      return Array.from(new Uint8Array(await (await fetch(element.src)).arrayBuffer()))
    })
    expect(Buffer.from(preview)).toEqual(buffer)
    await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
    await expect(page.getByText('0 photos selected locally')).toBeVisible()
    expect(uploads).toEqual([])
  })
}

test('keeps valid files while reporting spoofed, mismatched, and corrupt files', async ({ page }) => {
  const png = await generatedPhoto(page, 'image/png')
  await page.getByLabel('Choose photos').setInputFiles([
    { name: 'valid.png', mimeType: 'image/png', buffer: png },
    { name: 'renamed.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') },
    { name: 'mismatch.jpg', mimeType: 'image/jpeg', buffer: png },
    { name: 'broken.png', mimeType: 'image/png', buffer: png.subarray(0, 12) },
  ])
  await expect(page.getByText('1 photo selected locally')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('renamed.jpg: Unsupported photo')
  await expect(page.getByRole('alert')).toContainText('mismatch.jpg: The file type does not match')
  await expect(page.getByRole('alert')).toContainText('broken.png: This photo is corrupt')
})

test('rejects an oversized file', async ({ page }) => {
  await page.getByLabel('Choose photos').setInputFiles({
    name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  })
  await expect(page.getByRole('alert')).toContainText('20 MiB limit')
  await expect(page.getByText('0 photos selected locally')).toBeVisible()
})

test('bounds the number of selected photos', async ({ page }) => {
  const buffer = await generatedPhoto(page, 'image/png')
  await page.getByLabel('Choose photos').setInputFiles(
    Array.from({ length: 13 }, (_, index) => ({ name: `${index}.png`, mimeType: 'image/png', buffer })),
  )
  await expect(page.getByRole('alert')).toContainText('up to 12 photos')
  await expect(page.getByText('0 photos selected locally')).toBeVisible()
})

test('bounds the total selected bytes before decoding', async ({ page }) => {
  await page.getByLabel('Choose photos').evaluate((element: HTMLInputElement) => {
    const transfer = new DataTransfer()
    const payload = new Blob([new Uint8Array(18 * 1024 * 1024)])
    for (let index = 0; index < 6; index++) {
      transfer.items.add(new File([payload], `${index}.png`, { type: 'image/png' }))
    }
    element.files = transfer.files
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.getByRole('alert')).toContainText('selection exceeds 100 MiB')
  await expect(page.getByText('0 photos selected locally')).toBeVisible()
})

test('allows local selection when the API is offline and can retry its health check', async ({ page }) => {
  await page.route('**/healthz', (route) => route.fulfill({ status: 503, body: 'Unavailable' }))
  await page.reload()
  await expect(page.getByText('Unavailable — start the Go server on port 8080')).toBeVisible()
  const buffer = await generatedPhoto(page, 'image/png')
  await page.getByLabel('Choose photos').setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer })
  await expect(page.getByText('1 photo selected locally')).toBeVisible()
  await page.route('**/healthz', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ status: 'ok' }),
  }))
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
})

test('does not persist selected photos across reloads', async ({ page }) => {
  const buffer = await generatedPhoto(page, 'image/png')
  await page.getByLabel('Choose photos').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer })
  await expect(page.getByText('1 photo selected locally')).toBeVisible()
  await page.reload()
  await expect(page.getByText('0 photos selected locally')).toBeVisible()
})
