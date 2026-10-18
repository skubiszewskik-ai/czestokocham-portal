// Service worker Częstokocham: szybkie ponowne wejścia i czytanie bez zasięgu.
// Strony – najpierw sieć (zawsze świeże wiadomości), bez sieci kopia z pamięci albo /offline.
// Pliki z hashem, czcionki i zdjęcia – z pamięci (nigdy się nie zmieniają). Panel redakcji – zawsze z sieci.
const V = 'ck-v1';
const PAGES = `${V}-pages`;
const ASSETS = `${V}-assets`;
const OFFLINE = '/offline';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(PAGES).then((c) => c.addAll([OFFLINE, '/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(V)) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/admin')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = (await e.preloadResponse) || (await fetch(req));
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(PAGES).then((c) => c.put(url.pathname, copy)).then(() => trim(PAGES, 60)));
        }
        return res;
      } catch {
        return (await caches.match(url.pathname)) || (await caches.match(OFFLINE));
      }
    })());
    return;
  }

  if (/^\/(_astro|fonts|media|icons)\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(ASSETS).then((c) => c.put(req, copy)).then(() => trim(ASSETS, 300)));
      }
      return res;
    })());
  }
});
