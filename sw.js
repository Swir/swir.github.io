// SWIR OS dual-surface service worker.
// The public GitHub Pages showcase stays network-only, while the dedicated
// swir-desktop.html Web Edition keeps an offline-capable application shell.
const CACHE = 'swir-desktop-web-v2';
const LEGACY_CACHE_PREFIX = 'swir-os-';
const DESKTOP_CACHE_PREFIX = 'swir-desktop-web-';
const CORE = [
  './swir-desktop.html',
  './manifest.webmanifest',
  './swir-icon.svg',
  './swir-os.css',
  './swir-v11.css',
  './swir-v12.css',
  './swir-v13.css',
  './swir-v14.css',
  './swir-oobe.css',
  './swir-v15.css',
  './swir-v16.css',
  './swir-i18n.js',
  './swir-platform.js',
  './swir-file-storage.js',
  './swir-platform-bridge.js',
  './swir-packages.js',
  './swir-associations.js',
  './swir-notifications.js',
  './swir-package-resolver.js',
  './swir-sdk.js',
  './swir-app-bridge-host.js',
  './swir-apps.js',
  './swir-os.js',
  './swir-runtime.js',
  './swir-v11.js',
  './swir-v11-fixed.js',
  './swir-v12.js',
  './swir-v13.js',
  './swir-native.js',
  './swir-v14.js',
  './swir-oobe.js',
  './swir-v15.js',
  './swir-v16.js',
  './swir-v17.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key !== CACHE && (key.startsWith(LEGACY_CACHE_PREFIX) || key.startsWith(DESKTOP_CACHE_PREFIX)))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isDesktopNavigation(url, request) {
  return request.mode === 'navigate' && url.pathname.endsWith('/swir-desktop.html');
}

function isDesktopAsset(url) {
  if (!url.pathname.startsWith(self.registration.scope ? new URL(self.registration.scope).pathname : '/')) return false;
  const name = url.pathname.split('/').pop() || '';
  if (name.startsWith('swir-preview.')) return false;
  return name.startsWith('swir-') || name === 'manifest.webmanifest' || name === 'ding.mp3';
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match(fallbackUrl)) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Critical guarantee: the marketing/showcase root and its preview assets are never served
  // from this cache. This prevents the former PWA from pinning an obsolete public homepage.
  if (request.mode === 'navigate' && !isDesktopNavigation(url, request)) return;
  if (url.pathname.endsWith('/index.html') || url.pathname.endsWith('/') || url.pathname.includes('/swir-preview.')) return;

  if (isDesktopNavigation(url, request)) {
    event.respondWith(networkFirst(request, './swir-desktop.html'));
    return;
  }
  if (isDesktopAsset(url)) event.respondWith(staleWhileRevalidate(request));
});
