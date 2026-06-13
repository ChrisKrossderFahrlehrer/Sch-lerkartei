// ADK Service Worker — Network-First Strategie
// HTML kommt IMMER frisch vom Server → kein Cache-Löschen mehr nötig!
// Cache dient nur als Offline-Fallback.

const CACHE_NAME = 'adk-v4';

// Nur statische Assets die sich nie ändern → Cache-First erlaubt
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Installation ────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(() => console.log('Cache miss:', url))
        )
      )
    )
  );
  self.skipWaiting(); // Neuer SW übernimmt sofort
});

// ── Aktivierung: alte Caches löschen ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase / Google APIs / CDNs → Browser macht das selbst
  if (
    url.hostname.includes('firebase')   ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic')    ||
    url.hostname.includes('firebaseio') ||
    url.hostname.includes('firestore')  ||
    url.hostname.includes('jsdelivr')   ||
    url.hostname.includes('paypal')
  ) return;

  // Nur GET cachen
  if (event.request.method !== 'GET') return;

  const isStaticAsset = STATIC_ASSETS.some(a => url.pathname.endsWith(a.replace('/','')));

  if (isStaticAsset) {
    // Icons/Manifest → Cache-First (ändern sich nie)
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(resp => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return resp;
        })
      )
    );
    return;
  }

  // ── HTML & alles andere → NETWORK-FIRST ──
  // Immer frisch vom Server. Erfolgreiche Antwort aktualisiert den
  // Offline-Fallback-Cache. Nur wenn offline → Cache.
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then(cached =>
          cached || new Response('Offline – Seite nicht im Cache', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          })
        )
      )
  );
});
