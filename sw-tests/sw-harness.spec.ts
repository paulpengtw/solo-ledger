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

test('the harness observes a navigation answered from cache without reaching the server', async ({ page }) => {
  await activateServiceWorker(page)
  server.clearLog()

  await page.reload()

  // Deliberately provoked wrong behaviour (issue #40): the cached shell answers
  // the navigation and the network is never consulted.
  expect(server.requestsFor('/')).toBe(0)
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

test('the harness can deploy a new version to a client that still holds the old one cached', async ({ page, browser }) => {
  await activateServiceWorker(page)

  server.deploy('v2')

  // Positive control: a fresh, service-worker-free profile receives v2.
  const freshContext = await browser.newContext()
  const freshPage = await freshContext.newPage()
  await freshPage.goto(`${server.origin}/`)
  await expect(freshPage.locator('meta[name="deploy-version"]'))
    .toHaveAttribute('content', 'v2')
  await freshContext.close()

  // Deliberately provoked wrong behaviour (issue #40): the returning client
  // never receives v2 — not one reload late, never.
  await page.reload()
  await expect(page.locator('meta[name="deploy-version"]'))
    .toHaveAttribute('content', 'v1')
  await page.reload()
  await expect(page.locator('meta[name="deploy-version"]'))
    .toHaveAttribute('content', 'v1')
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
  await expect(page.locator('#submit-btn')).toBeVisible()
})
