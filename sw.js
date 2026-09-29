/* Pardes service worker. Written by pipeline/build_pwa.py; edit the script, not this file.

   The app page: the network first, so a new version shows the moment the app opens; the kept
   copy when there is no network or the network takes longer than PAGE_WAIT_MS. Every good
   answer replaces the kept copy.
   Icons and manifest: cache first.
   Sefaria API (https://www.sefaria.org/api/): network first, falling back to the copy
   kept from the last good answer, so verses opened before still show their sources offline.
   The shell cache is named after a hash of the built files, and activating a new build
   deletes the older shell caches. The Sefaria cache keeps its name across builds, holds
   at most API_MAX_ENTRIES answers and drops the oldest first. */
'use strict';

const BUILD = '94764d232e';
const SHELL_CACHE = 'pardes-shell-' + BUILD;
const API_CACHE = 'pardes-sefaria-v1';
const API_PREFIX = 'https://www.sefaria.org/api/';
const API_MAX_ENTRIES = 1500;
const PAGE_WAIT_MS = 4000;
const SHELL = ["./", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.location).href));
const INDEX_URL = new URL('./', self.location).href;
const INDEX_FILE_URL = new URL('index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(async (path) => {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      // Safari refuses a redirected response for a page load, so keep only the body.
      await cache.put(path, response.redirected ? await unredirect(response) : response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('pardes-') && name !== SHELL_CACHE && name !== API_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.url.startsWith(API_PREFIX)) {
    event.respondWith(networkFirst(event));
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.origin + url.pathname;
  if (request.mode === 'navigate' && (path === INDEX_URL || path === INDEX_FILE_URL)) {
    event.respondWith(pageFirst(event));
  } else if (SHELL_URLS.has(path)) {
    event.respondWith(fromShell(path, request));
  } else if (request.mode === 'navigate') {
    // any other address on this site: the network, and the app itself when offline
    event.respondWith(fetch(request).catch(() => fromShell(INDEX_URL, request)));
  }
});

async function pageFirst(event) {
  // a conditional request: when the page has not changed the answer is a short 304
  const fresh = fetch(INDEX_URL, { cache: 'no-cache' }).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(INDEX_URL, response.redirected ? await unredirect(response.clone()) : response.clone());
    }
    return response;
  });
  event.waitUntil(fresh.catch(() => {}));
  const kept = await (await caches.open(SHELL_CACHE)).match(INDEX_URL);
  if (!kept) return fresh;
  const late = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_WAIT_MS));
  try {
    const response = await Promise.race([fresh, late]);
    if (response && response.ok) return response.redirected ? unredirect(response) : response;
  } catch (error) { /* no network: the kept copy */ }
  return kept;
}

async function fromShell(key, request) {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match(key)) || fetch(request);
}

async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(API_CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const copy = await cache.match(request, { ignoreVary: true });
    if (copy) return copy;
    throw error;
  }
  if (response.ok) {
    event.waitUntil(remember(cache, request, response.clone()).catch(() => {}));
  } else if (response.status >= 500 || response.status === 429) {
    // a server error or Sefaria's rate limit: the last good answer, when there is one
    const copy = await cache.match(request, { ignoreVary: true });
    if (copy) return copy;
  }
  return response;
}

async function remember(cache, request, response) {
  await cache.put(request, response);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - API_MAX_ENTRIES; i += 1) await cache.delete(keys[i]);
}

async function unredirect(response) {
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
