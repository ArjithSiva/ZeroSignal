/* ZeroSignal service worker.
 * - App shell: cache-first for static assets, network-first for navigations (offline falls back to the cached shell).
 * - Public key: stale-while-revalidate, so signature checks work offline.
 * - Every other /api and /socket.io request is NEVER cached: alerts must come from the live server or the
 *   signed IndexedDB cache, not from an opaque HTTP cache.
 */
const VERSION = 'zerosignal-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/manifest-light.webmanifest', '/icon.svg'];
let apiBase = '';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'PRIME') {
    apiBase = e.data.apiUrl ?? '';
    e.waitUntil(fetch(`${apiBase}/api/alerts/public-key`).then((r) => caches.open(VERSION).then((c) => c.put(`${apiBase}/api/alerts/public-key`, r))).catch(() => {}));
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname === '/api/alerts/public-key') {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const cached = await c.match(req);
        const fresh = fetch(req).then((r) => {
          if (r.ok) c.put(req, r.clone());
          return r;
        });
        return cached ?? fresh;
      }),
    );
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      caches.open(VERSION).then((c) => c.put('/index.html', r.clone()));
      return r;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit ?? fetch(req).then((r) => {
      if (r.ok) caches.open(VERSION).then((c) => c.put(req, r.clone()));
      return r;
    })),
  );
});
