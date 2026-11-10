/* MARK UPSC — Service Worker
   Strategy:
   - Same-origin navigations AND app code (index.html, styles.css, hub.js,
     app.js): network-first, falling back to cache when offline. This
     guarantees online users always get the latest deployed build; the
     cache is only a safety net for offline use.
   - Same-origin static assets that never change once shipped (icons,
     manifest): cache-first, network fallback.
   - Cross-origin requests (Supabase auth/data, Razorpay checkout,
     the Groq/Gemini worker, Google Fonts) are left completely alone —
     never intercepted or cached. Payments, AI replies and live user
     data must always go to the network.
*/

// IMPORTANT: bump this on every deploy that changes styles.css / hub.js /
// app.js / index.html. These filenames are not content-hashed, so without
// a version bump, the "activate" handler below won't know there's an old
// cache to clear out. (App code itself is network-first now, so a missed
// bump is no longer the difference between fresh and stale — just belt
// and suspenders.)
const CACHE_VERSION = 'markupsc-v4';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/hub.js',
  '/app.js',
  '/manifest.json',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-144.png',
  '/icons/icon-152.png',
  '/icons/icon-192.png',
  '/icons/icon-384.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/offline.html'
];

// Paths that must always be fetched fresh when online (network-first),
// same as navigations. Everything else same-origin falls through to
// cache-first below.
const NETWORK_FIRST_PATHS = ['/styles.css', '/hub.js', '/app.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever handle GET requests on our own origin. Everything else —
  // Supabase, Razorpay, the AI worker, Google Fonts, any POST/PUT —
  // passes straight through untouched.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isNav = request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  const isAppCode = NETWORK_FIRST_PATHS.includes(url.pathname);

  // Main document + app code (JS/CSS): network-first with offline/cache
  // fallback, so online users never get stuck on a stale build.
  if (isNav || isAppCode) {
    event.respondWith(
      // { cache: 'no-store' } matters here: without it, "network-first"
      // can still be satisfied by the *browser's* own HTTP cache (e.g. if
      // the host sends a Cache-Control: max-age header on app.js) without
      // ever making a real round-trip to the server — silently serving a
      // stale build even though this code thinks it asked for a fresh one.
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || (isNav ? caches.match('/offline.html') : undefined))
        )
    );
    return;
  }

  // Static app-shell assets (icons, manifest): cache-first, network fallback.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => cached);
    })
  );
});

// Fired when a push arrives while the browser is running (tab open or not —
// this runs even if MarkUPSC isn't open, as long as the browser process is).
self.addEventListener('push', (event) => {
  let data = { title: 'MarkUPSC', body: 'You have a new update.', url: '/' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    tag: 'daily-motivation',  // replaces any previous unread motivation notif instead of stacking
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Fired when the user taps the notification — focuses an existing tab if
// one's open, otherwise opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
