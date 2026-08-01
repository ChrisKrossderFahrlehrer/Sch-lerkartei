// ADK Service Worker — Network-First Strategie
// HTML kommt IMMER frisch vom Server → kein Cache-Löschen mehr nötig!
// Cache dient nur als Offline-Fallback.

const CACHE_NAME = 'adk-v98';

// ── FCM Push: Hintergrund-Benachrichtigungen (data-only → wir zeigen selbst an) ──
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyD490kLzTOq3h3VdQ9ZqWZd_aXcDRfxBOs",
    authDomain: "fahrschule-ebc65.firebaseapp.com",
    projectId: "fahrschule-ebc65",
    storageBucket: "fahrschule-ebc65.firebasestorage.app",
    messagingSenderId: "194338111405",
    appId: "1:194338111405:web:73e2f31d69cde3ac9beb24"
  });
  const _fcm = firebase.messaging();
  _fcm.onBackgroundMessage((p) => {
    const d = (p && p.data) || {};
    self.registration.showNotification(d.title || 'FahrSync', {
      body: d.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { link: d.link || '/kalender.html' }
    });
  });
  self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const link = (e.notification.data && e.notification.data.link) || '/kalender.html';
    e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.includes('kalender') && 'focus' in c) return c.focus(); }
      return clients.openWindow(link);
    }));
  });
} catch (e) { /* Push ist optional – Cache-SW läuft trotzdem */ }


// Nur statische Assets die sich nie ändern → Cache-First erlaubt
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
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
  // Immer frisch vom Server. {cache:'no-store'} umgeht Safaris HTTP-Cache UND
  // den GitHub-Pages-CDN-Cache → Updates erscheinen SOFORT, nicht erst nach
  // 10 Minuten. Erfolgreiche Antwort aktualisiert den Offline-Fallback-Cache.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
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
