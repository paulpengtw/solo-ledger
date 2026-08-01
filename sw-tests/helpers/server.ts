import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const DIST = fileURLToPath(new URL('../../dist', import.meta.url))

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

export type HarnessServer = {
  origin: string
  /** How many requests for this exact path have reached the server. */
  requestsFor(path: string): number
  clearLog(): void
  /** Expired-session state: every browser-shaped request is redirected to the Access login stand-in. */
  setAuthenticated(authenticated: boolean): void
  /** Simulate a new deployment: the served index.html changes; sw.js stays byte-identical, as real deploys leave it. */
  deploy(version: string): void
  close(): Promise<void>
}

export async function startHarnessServer(): Promise<HarnessServer> {
  const log: { method: string; path: string }[] = []
  let authenticated = true
  let version = 'v1'

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname
    log.push({ method: request.method ?? 'GET', path })

    // Served in every auth state: reaching this page IS the success condition.
    if (path.startsWith('/cdn-cgi/access/login')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><head><title>Access login</title></head>'
        + '<body><h1>Access login stand-in</h1></body></html>',
      )
      return
    }

    if (!authenticated) {
      // Mirrors live Cloudflare Access (verified 2026-08-01 against
      // solo-ledger.pages.dev): XHR-shaped requests get 401, browser-shaped 302.
      if (request.headers['x-requested-with'] === 'XMLHttpRequest') {
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('401 Unauthorized')
        return
      }
      response.writeHead(302, {
        location: `/cdn-cgi/access/login/localhost?redirect_url=${encodeURIComponent(path)}`,
      })
      response.end()
      return
    }

    if (path.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }

    const filePath = path === '/' ? '/index.html' : path
    const resolved = normalize(join(DIST, filePath))
    if (!resolved.startsWith(DIST)) {
      response.writeHead(403)
      response.end()
      return
    }

    let body: string | Buffer
    try {
      body = await readFile(resolved)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    if (filePath === '/index.html') {
      body = body.toString('utf8').replace(
        '</head>',
        `<meta name="deploy-version" content="${version}"></head>`,
      )
    }
    // no-store keeps the browser HTTP cache out of the experiment: only the
    // service worker's CacheStorage can answer without reaching this server.
    response.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${port}`,
    requestsFor: path => log.filter(entry => entry.path === path).length,
    clearLog: () => { log.length = 0 },
    setAuthenticated: value => { authenticated = value },
    deploy: next => { version = next },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
