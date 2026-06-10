// DevisPro CI — sw.js v2
// Correction : ne précacher que les fichiers qui existent réellement

const CACHE_STATIC  = 'devispro-static-v2';
const CACHE_DYNAMIC = 'devispro-dynamic-v2';

const STATIC_ASSETS = [
  '/app.html',
  '/index.html',
  '/manifest.json',
  '/js/config.js',
  '/js/app.js',
  '/js/api.js',
  '/js/bot.js'
];

// ── Install ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      // addAll individuel pour ne pas bloquer si un fichier manque
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Impossible de précacher ${url}:`, err)
          )
        )
      );
    })
  );
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_DYNAMIC)
          .map(k => {
            console.log('[SW] Suppression ancien cache:', k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignorer les requêtes non-GET
  if (event.request.method !== 'GET') return;

  // API calls → network-first, jamais de cache
  if (url.hostname.includes('onrender.com') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'Hors ligne — réessaie dans un moment' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        )
      )
    );
    return;
  }

  // Mistral / ElevenLabs / CDN externes → network-only
  if (!url.hostname.includes(self.location.hostname) &&
      !url.pathname.startsWith('/icons/') &&
      !url.pathname.startsWith('/outputs/')) {
    return;
  }

  // PDF outputs → cache-first
  if (url.pathname.startsWith('/outputs/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_DYNAMIC).then(c => c.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Assets statiques → cache-first avec fallback réseau
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_DYNAMIC).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback hors-ligne : retourner app.html pour les navigations
        if (event.request.mode === 'navigate') {
          return caches.match('/app.html');
        }
      });
    })
  );
});
