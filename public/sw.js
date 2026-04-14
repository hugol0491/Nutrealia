// Service Worker — Mariana Nutrealia
// Estrategia: cache-first para app shell, network-only para APIs

const CACHE_NAME = 'nutrealia-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

// Instalar: cachear app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: stale-while-revalidate para shell, network-only para APIs
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIs y Google Sheets: siempre red, sin cache
  if (
    url.pathname.startsWith('/.netlify/functions/') ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('googleapis.com')
  ) {
    return; // Dejar que el navegador maneje normalmente
  }

  // App shell y assets: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(
          () =>
            cached ||
            new Response('', {
              status: 504,
              statusText: 'Offline y sin cache',
            })
        );

      return cached || networkFetch;
    })
  );
});
