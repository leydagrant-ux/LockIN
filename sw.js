/* sw.js — service worker.
 *
 * BUMP `VERSION` ON EVERY DEPLOY. Without a bump the old shell is served from
 * cache and your changes silently do not appear on either phone.
 *
 * `SHELL` MUST list every module index.html imports. index.html is a
 * type="module", so a file missing from this list is not a degraded app, it is
 * a BLANK app — the import chain dies and nothing renders. After any deploy
 * that touches the module list, fetch each file from the live site to confirm
 * it is really there.
 */

const VERSION = 'v0.3.7';
const CACHE = `lockin-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './ui.js',
  './config.js',
  './db.js',
  './ai.js',
  './foods.js',
  './anatomy.js',
  './anatomy-paths.js',
  './exercises.js',
  './program.js',
  './score.js',
  './stats.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* Individually, not addAll: addAll rejects the whole install if any single
       file 404s, which would leave the app with no service worker at all. */
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Never cache Firebase, the Worker, or the food APIs. Serving a stale workout
     or a stale macro lookup would be worse than failing. */
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    /* Network first for the app shell so a deploy is picked up as soon as the
       phone has signal, falling back to cache when it does not. */
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      /* A navigation with no cache entry still needs to render something. */
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and not cached');
    }
  })());
});
