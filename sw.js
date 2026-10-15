const CACHE = 'maintainr-v5-sqlite';
const APP_FILES = [
  '/', '/index.html', '/styles.css?v=5', '/app.js?v=5',
  '/src/pwa.mjs', '/src/domain.mjs', '/src/database.mjs', '/src/schema.mjs',
  '/vendor/sql.js/sql-wasm.js', '/vendor/sql.js/sql-wasm.wasm',
  '/manifest.webmanifest', '/icon.svg',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)));
});
self.addEventListener('message', event => {
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('maintainr-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  // Serve a complete release, including SQLite, from one cache. A newer release
  // waits until the user accepts it or closes all windows. Never cache user data.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === 'navigate') return cache.match('/index.html');
    return fetch(event.request);
  })());
});
