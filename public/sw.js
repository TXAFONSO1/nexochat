const CACHE = 'nexo-v5';
const SHELL = ['/', '/style.css', '/app.js', '/js/voice.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sse' || url.pathname.startsWith('/files/')) return;

  // rede primeiro: so usa cache se a rede falhar (app offline)
  if (SHELL.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.open(CACHE).then(cache => cache.match(e.request)).then(m => m || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const network = fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(e.request, res.clone());
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
