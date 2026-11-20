const CACHE_NAME = 'snappdf-v1';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tokens.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './js/app.js',
  './js/db.js',
  './js/worker-bridge.js',
  './js/pdf-worker.js',
  './js/ui-grid.js',
  './js/ui-settings.js',
  './js/ui-preview.js',
  './js/tools-crop.js',
  './js/tools-scan.js',
  './js/tools-redact.js',
  './js/tools-extras.js',
  './vendor/pdf-engine.js',
  './vendor/sort-helper.js',
  './icons/sprite.svg',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
