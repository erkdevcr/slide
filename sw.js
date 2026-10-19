/* Slideshow service worker — cache-bust via version.json
 * Sirve la carpeta por HTTP (p.ej. python -m http.server). No funciona en file://.
 */
const VERSION_URL = './version.json';
const APP_SHELL = ['./slideshow.html', './version.json', './sw.js'];

let currentVersion = null;

async function fetchVersion(cacheMode) {
  const res = await fetch(VERSION_URL + '?t=' + Date.now(), {
    cache: cacheMode || 'no-store',
    credentials: 'same-origin'
  });
  if (!res.ok) throw new Error('version ' + res.status);
  return res.json();
}

function cacheNameFor(v) {
  const id = (v && (v.version || v.build)) ? String(v.version || '') + '-b' + String(v.build || 0) : 'unknown';
  return 'slideshow-' + id;
}

async function precache(version) {
  const name = cacheNameFor(version);
  const cache = await caches.open(name);
  await cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' })));
  return name;
}

async function dropOldCaches(keepName) {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('slideshow-') && k !== keepName).map(k => caches.delete(k)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      currentVersion = await fetchVersion('no-store');
      await precache(currentVersion);
    } catch (e) {
      // Sin red: aún activamos; fetch usará lo que haya
      console.warn('[sw] install precache', e);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      if (!currentVersion) currentVersion = await fetchVersion('no-store');
      const keep = cacheNameFor(currentVersion);
      await dropOldCaches(keep);
    } catch (e) {
      console.warn('[sw] activate', e);
    }
    await self.clients.claim();
  })());
});

function isNavOrHtml(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  const url = new URL(req.url);
  return url.pathname.endsWith('.html') || url.pathname.endsWith('/');
}

async function networkFirst(req, cacheKeyHint) {
  const cache = await caches.open(cacheKeyHint || cacheNameFor(currentVersion) || 'slideshow-fallback');
  try {
    const net = await fetch(req, { cache: 'no-store' });
    if (net && net.ok) {
      try { await cache.put(req, net.clone()); } catch (_) {}
    }
    return net;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // try slideshow.html as SPA-ish fallback for navigations
    const shell = await cache.match('./slideshow.html');
    if (shell) return shell;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // version.json siempre red primero
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('version.json')) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        if (net.ok) {
          try {
            const v = await net.clone().json();
            const prev = currentVersion && (currentVersion.version + '-' + currentVersion.build);
            const next = v.version + '-' + v.build;
            if (prev && prev !== next) {
              currentVersion = v;
              const name = await precache(v);
              await dropOldCaches(name);
              const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
              clients.forEach(c => c.postMessage({ type: 'NEW_VERSION', version: v }));
            } else {
              currentVersion = v;
            }
            const c = await caches.open(cacheNameFor(v));
            await c.put('./version.json', net.clone());
          } catch (_) {}
        }
        return net;
      } catch (e) {
        const keys = await caches.keys();
        for (const k of keys) {
          if (!k.startsWith('slideshow-')) continue;
          const hit = await caches.open(k).then(c => c.match('./version.json'));
          if (hit) return hit;
        }
        throw e;
      }
    })());
    return;
  }

  if (isNavOrHtml(req) || url.pathname.endsWith('/sw.js') || url.pathname.endsWith('sw.js')) {
    event.respondWith(networkFirst(req, cacheNameFor(currentVersion)));
    return;
  }

  // Otros assets del mismo origen: cache-first con actualización en segundo plano
  event.respondWith((async () => {
    const name = cacheNameFor(currentVersion) || 'slideshow-fallback';
    const cache = await caches.open(name);
    const hit = await cache.match(req);
    const netPromise = fetch(req).then(async (net) => {
      if (net && net.ok) try { await cache.put(req, net.clone()); } catch (_) {}
      return net;
    }).catch(() => null);
    if (hit) {
      netPromise.catch(() => {});
      return hit;
    }
    const net = await netPromise;
    if (net) return net;
    throw new Error('offline');
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', version: currentVersion });
  }
});
