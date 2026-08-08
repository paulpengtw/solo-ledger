import { expect, test, type Page } from '@playwright/test'
import { startHarnessServer, type HarnessServer } from './helpers/server'

let server: HarnessServer

test.beforeEach(async () => {
  server = await startHarnessServer()
})

test.afterEach(async () => {
  await server.close()
})

async function activateServiceWorker(page: Page): Promise<void> {
  await page.goto(`${server.origin}/`)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        )
      })
    }
  })
}

test('positive control: the counter registers two when one navigation causes two genuine requests', async ({ page }) => {
  // Registering the worker makes install re-fetch '/' for the app-shell cache,
  // so a single navigation genuinely hits '/' twice: navigation + cache.addAll.
  await activateServiceWorker(page)
  expect(server.requestsFor('/')).toBe(2)

  // Second control through a path the worker never touches: two POSTs, two hits.
  await page.evaluate(() => fetch('/api/ping', { method: 'POST' }))
  await page.evaluate(() => fetch('/api/ping', { method: 'POST' }))
  expect(server.requestsFor('/api/ping')).toBe(2)
})

test('a navigation consults the network even when the shell is cached', async ({ page }) => {
  await activateServiceWorker(page)
  server.clearLog()

  await page.reload()

  expect(server.requestsFor('/')).toBe(1)
})

test('an expired session lands a navigation on the Access login, not the cached shell', async ({ page }) => {
  await activateServiceWorker(page)
  server.setAuthenticated(false)

  await page.reload()

  await expect(page).toHaveTitle('Access login')
  expect(page.url()).toContain('/cdn-cgi/access/login')
})

test('requests to /cdn-cgi/ paths are never answered by the service worker', async ({ page }) => {
  await activateServiceWorker(page)

  await page.evaluate(() => fetch('/cdn-cgi/access/login/probe'))
  await page.evaluate(() => fetch('/cdn-cgi/access/login/probe'))

  expect(server.requestsFor('/cdn-cgi/access/login/probe')).toBe(2)

  const cachedPaths = await page.evaluate(async () => {
    const keys = await caches.keys()
    const paths: string[] = []
    for (const key of keys) {
      const cache = await caches.open(key)
      for (const entry of await cache.keys()) {
        paths.push(new URL(entry.url).pathname)
      }
    }
    return paths
  })
  expect(cachedPaths.filter(path => path.startsWith('/cdn-cgi/'))).toEqual([])
})

test('the harness can assert CacheStorage contents after activation', async ({ page }) => {
  await activateServiceWorker(page)

  const stored = await page.evaluate(async () => {
    const keys = await caches.keys()
    const cache = await caches.open(keys[0] ?? '')
    const entries = await cache.keys()
    return { keys, paths: entries.map(entry => new URL(entry.url).pathname) }
  })

  expect(stored.keys).toContain('solo-ledger-shell-v1')
  expect(stored.paths).toContain('/')
})

test('a returning client receives a newly deployed version', async ({ page, browser }) => {
  await activateServiceWorker(page)

  server.deploy('v2')

  // Positive control: a fresh, service-worker-free profile receives v2.
  const freshContext = await browser.newContext()
  const freshPage = await freshContext.newPage()
  await freshPage.goto(`${server.origin}/`)
  await expect(freshPage.locator('meta[name="deploy-version"]'))
    .toHaveAttribute('content', 'v2')
  await freshContext.close()

  // The returning client receives the new version on its next reload.
  await page.reload()
  await expect(page.locator('meta[name="deploy-version"]'))
    .toHaveAttribute('content', 'v2')
})

test('the harness can simulate an unauthenticated origin without a real Access session', async ({ browser }) => {
  server.setAuthenticated(false)

  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${server.origin}/`)

  await expect(page).toHaveTitle('Access login')
  expect(page.url()).toContain('/cdn-cgi/access/login')
  await context.close()
})

test('offline instrument: an authenticated client still opens the app with no network', async ({ page, context }) => {
  await activateServiceWorker(page)
  // A controlled reload routes the hashed assets through the worker's runtime
  // caching; only then can the app open fully offline.
  await page.reload()

  await context.setOffline(true)
  await page.reload()

  await expect(page).toHaveTitle('Solo Ledger')
  // The stepped flow opens on the amount step; 記帳 lives in the 確認 step's
  // panel, display:none until that step activates — attached, never visible.
  await expect(page.getByRole('heading', { name: '金額多少？' })).toBeVisible()
  await expect(page.locator('#submit-btn')).toBeAttached()
})

test('the offline fallback shell tracks the newest deployed version', async ({ page, context }) => {
  await activateServiceWorker(page)
  await page.reload()

  server.deploy('v2')
  await page.reload()

  await context.setOffline(true)
  await page.reload()

  await expect(page.locator('meta[name="deploy-version"]'))
    .toHaveAttribute('content', 'v2')
})
