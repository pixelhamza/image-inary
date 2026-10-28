import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: 'http://localhost:5179',
    browserName: 'chromium',
    launchOptions: {
      // Optional installed Chromium/Chrome path; otherwise use Playwright Chromium.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5179',
    url: 'http://localhost:5179',
    reuseExistingServer: false,
  },
})
