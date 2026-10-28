import type { Page } from '@playwright/test'

export async function generatedPhoto(page: Page, mime: 'image/png' | 'image/jpeg') {
  const base64 = await page.evaluate((type) => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 3
    const context = canvas.getContext('2d')!
    context.fillStyle = '#047857'
    context.fillRect(0, 0, 2, 3)
    return canvas.toDataURL(type).split(',')[1]
  }, mime)
  return Buffer.from(base64, 'base64')
}

// Synthetic two-frame, 1x1 GIF. No personal media or external fixture downloads.
export function animatedGIF() {
  return Buffer.from([
    ...Buffer.from('GIF89a'), 1, 0, 1, 0, 128, 0, 0,
    0, 0, 0, 255, 255, 255,
    33, 255, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0,
    33, 249, 4, 0, 10, 0, 0, 0,
    44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0,
    33, 249, 4, 0, 10, 0, 0, 0,
    44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 76, 1, 0,
    59,
  ])
}
