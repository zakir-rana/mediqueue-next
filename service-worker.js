// ══════════════════════════════════════════════════════
// MediQueue Next — Service Worker v3.0
// Production-grade: versioned cache, stale cleanup,
// offline fallback, safe fetch handling, cache growth prevention
// Repo: zakir-rana/mediqueue-next
// ══════════════════════════════════════════════════════

const CACHE_VERSION   = 'mq-v3.0.0';
const STATIC_CACHE    = CACHE_VERSION + '-static';
const DYNAMIC_CACHE   = CACHE_VERSION + '-dynamic';
const OFFLINE_URL     = './offline.html';

// Assets to pre-cache on install (app shell)
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// External URLs to cache on first use (network-first strategy)
const EXTERNAL_ASSETS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdn.jsdelivr.net/npm/kalpurush@1.0.0/',
  'https://fonts.maateen.me/kalpurush/',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/',
];

// Never cache these — always hit network
const NEVER_CACHE = [
  'supabase.co',
  'api.supabase',
  '.supabase.io',
  'chrome-extension',
];

// Max entries in dynamic cache to prevent growth
const DYNAMIC_CACHE_MAX = 60;

// ── INSTALL ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        // Cache individually so a single failure doesn't block install
        return Promise.allSettled(
          STATIC_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] Failed to cache on install:', url, err.message);
            })
          )
        );
      })
      .then(() => {
        console.log('[SW] Installed', CACHE_VERSION);
        return self.skipWaiting(); // Activate immediately
      })
  );
});

// ── ACTIVATE ─────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => {
            // Delete all caches that don't match current version
            return name.startsWith('mq-') &&
                   name !== STATIC_CACHE &&
                   name !== DYNAMIC_CACHE;
          })
          .map((name) => {
            console.log('[SW] Deleting stale cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] Activated', CACHE_VERSION);
      return self.clients.claim(); // Take control of all open pages immediately
    })
  );
});

// ── FETCH ─────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET requests entirely
  if (request.method !== 'GET') return;

  // Skip chrome-extension, data:, blob: URLs
  if (!url.startsWith('http')) return;

  // Never cache Supabase/API calls — always network
  if (NEVER_CACHE.some((pattern) => url.includes(pattern))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Google Fonts CSS — stale-while-revalidate (fast first load + background update)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // CDN assets (Kalpurush font, Supabase JS bundle) — cache-first (immutable CDN)
  if (url.includes('cdn.jsdelivr.net') || url.includes('fonts.maateen.me')) {
    event.respondWith(cacheFirst(request, DYNAMIC_CACHE));
    return;
  }

  // App shell files — network-first with cache fallback (ensures fresh HTML/JS/CSS)
  // Uses self.location.origin to be repo-name agnostic: matches any request
  // to the same GitHub Pages origin as the service worker itself.
  if (url.startsWith(self.location.origin + '/mediqueue-next/')) {
    event.respondWith(networkFirstWithFallback(request));
    return;
  }

  // Everything else — stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
});

// ── STRATEGIES ────────────────────────────────────────

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response('Network error', { status: 503 });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
      await trimCache(cacheName, DYNAMIC_CACHE_MAX);
    }
    return response;
  } catch {
    return cachedOrOffline(request);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cacheName, DYNAMIC_CACHE_MAX);
    }
    return response;
  }).catch(() => null);

  return cached || (await networkPromise) || cachedOrOffline(request);
}

async function networkFirstWithFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      // Update cache with fresh copy (enables offline future visits)
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    // Network failed — try cache
    const cached = await caches.match(request);
    if (cached) return cached;

    // If navigation request, serve offline page
    if (request.mode === 'navigate') {
      const offlineResponse = await caches.match(OFFLINE_URL);
      if (offlineResponse) return offlineResponse;
    }

    return new Response('Offline — please check your connection', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function cachedOrOffline(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  if (request.mode === 'navigate') {
    return (await caches.match(OFFLINE_URL)) ||
      new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
  return new Response('Resource unavailable offline', { status: 503 });
}

// ── CACHE TRIM ────────────────────────────────────────
// Prevents unbounded cache growth
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    // Delete oldest entries (FIFO — keys() returns in insertion order)
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// ── MESSAGE HANDLER ────────────────────────────────────
// Allows app to trigger SW actions via postMessage
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n.startsWith('mq-')).map((n) => caches.delete(n)))
    ).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }

  if (event.data.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
});
