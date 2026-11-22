/**
 * Service Worker: зберігає «оболонку» застосунку в Cache Storage,
 * щоб LocalDo відкривався без інтернету.
 * Стратегія: спочатку кеш, у фоні — оновлення з мережі (stale-while-revalidate).
 */
const CACHE = 'localdo-v2';
const SHELL = [
  './', './index.html', './about.html', './css/styles.css',
  './js/app.js', './js/model.js', './js/db.js', './js/sync.js', './js/net.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Видаляємо кеші старих версій
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
        .catch(() => cached || cache.match('./index.html'));
      return cached || network;
    }),
  );
});
