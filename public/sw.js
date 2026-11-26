// Service worker mínimo: permite instalar la app y que abra rápido.
// Los datos (Firestore, Firebase Auth, Gemini) NO se guardan aquí: siempre van a la red.
// Cambia VERSION cuando quieras forzar que los celulares descarguen todo de nuevo.
const VERSION = 'v1';
const CACHE = `colaboradores-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Solo archivos propios y GET. Todo lo demás (Firebase, APIs) va directo a internet.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Páginas: primero red (siempre la versión nueva), si no hay internet usa la copia guardada.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Archivos estáticos (JS, CSS, imágenes): primero la copia guardada, y se refresca en segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const red = fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => cached);
      return cached || red;
    })
  );
});
