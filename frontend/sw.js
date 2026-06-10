// DevisPro CI — sw.js v1
const CACHE_STATIC  = 'devispro-static-v1';
const CACHE_DYNAMIC = 'devispro-dynamic-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.html',
  '/manifest.json',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/bot.js',
  '/js/pdf.js'
];

// ── Install : précache des assets statiques ────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate : purge anciens caches ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_STATIC && k !== CACHE_DYNAMIC)
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch : stratégie mixte ────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls : network-first, pas de cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Hors ligne — réessaie dans un moment' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503
        })
      )
    );
    return;
  }

  // PDF outputs : cache-first
  if (url.pathname.startsWith('/outputs/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_DYNAMIC).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Assets statiques : cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_DYNAMIC).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
