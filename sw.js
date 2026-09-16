// SWIR OS showcase cache-retirement worker.
// The former Web Edition PWA used this origin and may still control returning visitors.
// This worker deliberately removes those legacy caches and unregisters itself so the
// public swir.github.io showcase is always served directly from GitHub Pages.
const LEGACY_CACHE_PREFIX = 'swir-os-';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys();
    await Promise.all(
      cacheKeys
        .filter(key => key.startsWith(LEGACY_CACHE_PREFIX))
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
    await self.registration.unregister();

    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    await Promise.all(windows.map(async client => {
      try {
        await client.navigate(client.url);
      } catch {
        // A browser may reject navigation during activation; the next reload will
        // still be network-only because this worker has already unregistered.
      }
    }));
  })());
});
