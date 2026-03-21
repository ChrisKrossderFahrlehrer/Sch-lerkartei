// Schülerkartei Service Worker
// Cached die App-Shell damit sie auch ohne Internet startet

const CACHE_NAME = 'schuelerkartei-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/fahrschule-app.html',
];

// Installation: App-Dateien cachen
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Einzeln versuchen falls eine URL nicht verfügbar
        return Promise.all(
          APP_SHELL.map(url =>
            cache.add(url).catch(() => console.log('Cache miss:', url))
          )
        );
      });
    })
  );
  self.skipWaiting();
});

// Aktivierung: alten Cache löschen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: Cache-first für App-Shell, Network-first für Firebase
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase & externe APIs → immer Netzwerk, kein Cache
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('firebaseio') ||
    url.hostname.includes('firestore')
  ) {
    return; // Browser handhabt Firebase selbst (IndexedDB-Persistenz)
  }

  // App-Shell → Cache-first, Fallback auf Netzwerk
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Erfolgreiche Antworten in Cache speichern
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline und nicht im Cache → nichts zurückgeben
        return new Response('Offline – Seite nicht im Cache', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      });
    })
  );
});
