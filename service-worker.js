// ══════════════════════════════════════════════════════
// MediQueue Next — Service Worker v3.1
// FIX v3.1: offline.html no longer replaces the app.
//
// ROOT CAUSE (v3.0 bug):
//   STATIC_ASSETS used relative paths ('./', './index.html')
//   but fetch events arrive with full URLs
//   (https://zakir-rana.github.io/mediqueue-next/).
//   caches.match(request) compared full URL vs relative key
//   → MISS → offline.html shown instead of cached app shell.
//
// FIX:
//   1. Install: cache all assets by FULL URL (resolved from
//      self.location) so cache keys always match fetch URLs.
//   2. networkFirstWithFallback: on network failure, try cache
//      match on the exact URL, then try the base index.html
//      URL explicitly before ever touching offline.html.
//   3. offline.html is ONLY served when BOTH conditions are true:
//      a) Network is unavailable
//      b) index.html is not in cache (fresh device, never visited)
//
// Repo: zakir-rana/mediqueue-next
// ══════════════════════════════════════════════════════

const CACHE_VERSION  = 'mq-v3.1.0';
const STATIC_CACHE   = CACHE_VERSION + '-static';
const DYNAMIC_CACHE  = CACHE_VERSION + '-dynamic';

// Resolved at SW install time — self.location.href is always the
// full URL of service-worker.js, e.g.:
//   https://zakir-rana.github.io/mediqueue-next/service-worker.js
// _BASE strips the filename to get the app root:
//   https://zakir-rana.github.io/mediqueue-next/
const _BASE = self.location.href.replace(/service-worker\.js.*$/, '');

// Offline fallback URL (full, resolved)
const OFFLINE_URL = _BASE + 'offline.html';

// ── APP SHELL ASSETS ──────────────────────────────────
// All paths resolved to FULL URLs at declaration time.
// This guarantees cache keys == fetch request URLs → no mismatches.
const STATIC_ASSETS = [
  _BASE,                          // bare directory URL (→ index.html)
  _BASE + 'index.html',
  _BASE + 'app.js',
  _BASE + 'styles.css',
  _BASE + 'manifest.json',
  _BASE + 'offline.html',
  _BASE + 'firebase-config.js',
  _BASE + 'icons/icon-192.png',
  _BASE + 'icons/icon-512.png',
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
    caches.open(STATIC_CACHE).then((cache) => {
      // Cache each asset individually — a single 404 won't block install
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to pre-cache:', url, err.message);
          })
        )
      );
    }).then(() => {
      console.log('[SW] Installed', CACHE_VERSION, '| base:', _BASE);
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
          .filter((name) =>
            name.startsWith('mq-') &&
            name !== STATIC_CACHE &&
            name !== DYNAMIC_CACHE
          )
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

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip non-http(s) URLs (chrome-extension, data:, blob:)
  if (!url.startsWith('http')) return;

  // Never cache Supabase/API calls — always network
  if (NEVER_CACHE.some((pattern) => url.includes(pattern))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Google Fonts CSS — stale-while-revalidate
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // CDN assets (Kalpurush font, Supabase JS bundle) — cache-first
  if (url.includes('cdn.jsdelivr.net') || url.includes('fonts.maateen.me')) {
    event.respondWith(cacheFirst(request, DYNAMIC_CACHE));
    return;
  }

  // App shell — network-first with guaranteed cache fallback.
  // Matches any request under the same GitHub Pages path as the SW.
  if (url.startsWith(_BASE)) {
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

// ── networkFirstWithFallback ───────────────────────────
// KEY FIX: On network failure, this function now has a
// proper 3-tier fallback:
//   1. Try cache for the exact requested URL
//   2. Try cache for the index.html root (catches bare-dir requests)
//   3. ONLY if both miss AND it's a navigation → serve offline.html
//
// This means a cached app ALWAYS opens offline.
// offline.html only appears on a device that has NEVER loaded the app.
async function networkFirstWithFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Update static cache with fresh copy
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    // Network failed — tier 1: exact URL match
    const cached = await caches.match(request);
    if (cached) return cached;

    // Tier 2: for navigation requests, explicitly try index.html
    // (handles both bare directory URL and any deep path that
    // should render the SPA shell)
    if (request.mode === 'navigate') {
      // Try the bare directory index (catches _BASE and _BASE + 'index.html')
      const indexCached =
        (await caches.match(_BASE + 'index.html')) ||
        (await caches.match(_BASE));
      if (indexCached) {
        console.log('[SW] Serving index.html from cache (offline)');
        return indexCached;
      }

      // Tier 3: app shell is NOT cached → serve offline.html as last resort
      const offlineCached = await caches.match(OFFLINE_URL);
      if (offlineCached) {
        console.warn('[SW] App shell missing — serving offline.html');
        return offlineCached;
      }

      // Absolute last resort: inline minimal offline page
      return new Response(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>MediQueue — Offline</title></head>' +
        '<body style="background:#0a1628;color:#f3f6fc;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">' +
        '<div><div style="font-size:48px">🩺</div><h1>Offline</h1>' +
        '<p style="color:#9fb0c9">আপনি অফলাইনে আছেন। পুনরায় চেষ্টা করুন।</p>' +
        '<button onclick="location.reload()" style="margin-top:20px;padding:12px 24px;background:#1a56e8;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">↻ Retry</button>' +
        '</div></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    // Non-navigation sub-resource miss
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

async function cachedOrOffline(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  if (request.mode === 'navigate') {
    // Same 3-tier logic for other strategies
    const indexCached =
      (await caches.match(_BASE + 'index.html')) ||
      (await caches.match(_BASE));
    if (indexCached) return indexCached;
    return (await caches.match(OFFLINE_URL)) ||
      new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
  return new Response('Resource unavailable offline', { status: 503 });
}

// ── CACHE TRIM ────────────────────────────────────────
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// ── MESSAGE HANDLER ────────────────────────────────────
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
