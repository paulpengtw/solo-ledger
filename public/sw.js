const CACHE_NAME = 'solo-ledger-shell-v1'
const APP_SHELL = ['/', '/manifest.webmanifest']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  // Cloudflare's own /cdn-cgi/ endpoints carry single-use Access credentials
  // and must always reach the network untouched.
  if (url.pathname.startsWith('/cdn-cgi/')) {
    return
  }
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return
  }

  // Navigations must consult the network first: an expired Cloudflare Access
  // session answers with a redirect the browser must be allowed to follow to
  // the login page. The cached shell is only the offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok && url.pathname === '/') {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then(cache => cache.put('/', copy))
        }
        return response
      }).catch(() => caches.match('/')),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
        }
        return response
      })
    }),
  )
})
