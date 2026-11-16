// Service worker: keeps the app's own files on the phone so it opens with no signal.
const CACHE = 'sfm-receipts-v11';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files: answer from the phone's copy right away, refresh it in the background when online.
// Anything else (the back end) goes straight to the network.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('config.js')) {
    // Settings file: try the network first (3 seconds), fall back to the phone's copy.
    e.respondWith(
      Promise.race([
        fetch(e.request, { cache: 'no-cache' }).then(resp => {
          if (resp && resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          return resp;
        }),
        new Promise((_, rej) => setTimeout(rej, 3000))
      ]).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request, { ignoreSearch: true }).then(cached => {
        const fresh = fetch(e.request, { cache: 'no-cache' }).then(resp => {
          if (resp && resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || fresh;
      })
    )
  );
});
