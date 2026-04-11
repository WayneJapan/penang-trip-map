// ============================================================
// Service Worker — 槟城行程地图 PWA
// Strategy:
//   - App Shell (HTML/JS/CSS/fonts): Cache-First
//   - Map Tiles: Stale-While-Revalidate (browse once to cache)
//   - API (OSRM/Overpass): Network-Only (graceful fallback in app)
// ============================================================

const CACHE_NAME = 'penang-trip-v3';
const TILE_CACHE = 'penang-tiles-v1';
const MAX_TILE_CACHE = 3000; // ~15 MB assuming ~5 KB/tile

// Core app shell resources to pre-cache on install
const APP_SHELL = [
  './',
  './index.html',
  './penang-trip-map-nearby-fixed.html',
  './trip-map.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// Install: pre-cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== TILE_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch handler
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Map tiles — Stale-While-Revalidate
  if (isTileRequest(url)) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // 2. API requests (OSRM, Overpass) — Network only
  if (isApiRequest(url)) {
    event.respondWith(fetch(event.request).catch(() => new Response('{"error":"offline"}', {
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // 3. App shell & other resources — Cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Ultimate fallback for navigation requests
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html') || caches.match('./trip-map.html');
      }
    })
  );
});

// Tile preload message handler
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'PRELOAD_TILES') {
    preloadTiles(event.data.bounds, event.data.zooms || [13, 14, 15, 16])
      .then(count => {
        event.source.postMessage({ type: 'PRELOAD_DONE', count });
      })
      .catch(err => {
        event.source.postMessage({ type: 'PRELOAD_ERROR', error: err.message });
      });
  }
  if (event.data && event.data.type === 'GET_TILE_CACHE_SIZE') {
    caches.open(TILE_CACHE).then(cache => cache.keys()).then(keys => {
      event.source.postMessage({ type: 'TILE_CACHE_SIZE', count: keys.length });
    });
  }
});

// ---- Helpers ----

function isTileRequest(url) {
  return url.hostname.includes('basemaps.cartocdn.com') ||
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('tiles.stadiamaps.com') ||
    url.pathname.includes('/tile/');
}

function isApiRequest(url) {
  return url.hostname.includes('overpass') ||
    url.hostname.includes('routing.openstreetmap.de') ||
    url.hostname.includes('router.project-osrm.org');
}

async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(async response => {
    if (response.ok) {
      // Trim cache if too large
      const keys = await cache.keys();
      if (keys.length > MAX_TILE_CACHE) {
        // Delete oldest 500 tiles
        for (let i = 0; i < 500 && i < keys.length; i++) {
          await cache.delete(keys[i]);
        }
      }
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached); // If network fails, return cached

  return cached || networkFetch;
}

async function preloadTiles(bounds, zooms) {
  const cache = await caches.open(TILE_CACHE);
  let count = 0;
  const template = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png';

  for (const z of zooms) {
    const minTile = latLngToTile(bounds.south, bounds.west, z);
    const maxTile = latLngToTile(bounds.north, bounds.east, z);
    const xMin = Math.min(minTile.x, maxTile.x);
    const xMax = Math.max(minTile.x, maxTile.x);
    const yMin = Math.min(minTile.y, maxTile.y);
    const yMax = Math.max(minTile.y, maxTile.y);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        try {
          const existing = await cache.match(url);
          if (!existing) {
            const resp = await fetch(url);
            if (resp.ok) {
              await cache.put(url, resp);
              count++;
            }
          }
          // Small delay to avoid hammering the server
          if (count % 20 === 0) await new Promise(r => setTimeout(r, 100));
        } catch (e) { /* skip failed tiles */ }
      }
    }
  }
  return count;
}

function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}
