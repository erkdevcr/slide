/* Slideshow service worker — cache-bust via version.json
 * Sirve la carpeta por HTTP (p.ej. python -m http.server). No funciona en file://.
 * GitHub Pages: index.html; local: slideshow.html. Precache resiliente (ignora 404).
 */
const VERSION_URL = './version.json';
const APP_SHELL = [
  './index.html',
  './slideshow.html',
  './',
  './version.json',
  './sw.js'
];

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

/** Precache each URL individually so a missing file (e.g. slideshow.html on Pages) does not fail install. */
async function precache(version) {
  const name = cacheNameFor(version);
  const cache = await caches.open(name);
  await Promise.all(APP_SHELL.map(async (u) => {
    try {
      const req = new Request(u, { cache: 'reload' });
      const res = await fetch(req);
      if (res && res.ok) {
        await cache.put(req, res);
      }
    } catch (e) {
      console.warn('[sw] precache skip', u, e);
    }
  }));
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

async function matchShellFallback(cache) {
  const candidates = ['./index.html', './slideshow.html', './'];
  for (const u of candidates) {
    const hit = await cache.match(u);
    if (hit) return hit;
  }
  return null;
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
    const shell = await matchShellFallback(cache);
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
