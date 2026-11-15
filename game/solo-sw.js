// Solo mode offline: saves every game file on install, then serves solo pages from that copy
// first (instant, works on a plane) while quietly refreshing it from the network for next time.
// Online pages (no solo=1) are never touched: they always go straight to the network.
importScripts('/game/solo-sw-files.js');
const CACHE = 'taproot-solo-' + self.SOLO_VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(self.SOLO_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('taproot-solo-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function isSolo(e) {
  if (e.request.mode === 'navigate') return new URL(e.request.url).searchParams.get('solo') === '1';
  const client = e.clientId && (await self.clients.get(e.clientId));
  return !!client && new URL(client.url).searchParams.get('solo') === '1';
}

async function handle(e) {
  const req = e.request;
  if (req.method !== 'GET' || !(await isSolo(e))) return fetch(req);
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: new URL(req.url).origin === location.origin });
  const fresh = fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(req.mode === 'navigate' ? '/game/world3d/' : req, res.clone());
    return res;
  });
  if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
  return fresh; // not saved yet (e.g. a font): network, and keep it for next time
}

self.addEventListener('fetch', (e) => e.respondWith(handle(e)));
