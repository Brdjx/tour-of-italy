/*
 * Service worker for 3 Days in Italy. Hand-written, no dependencies.
 *
 * routeRequest() picks one strategy per request (test/sw/routing.test.ts covers every class):
 *   GET /_next/static/*               cache first (file names are content hashes)
 *   page navigations                  network first, the cached app shell when offline
 *   GET /api/meta, GET /api/places    stale-while-revalidate, only readable JSON of the right shape
 *   everything else under /api/       not handled: straight to the network, never cached
 *   other same-origin GETs            the precached copy if there is one, else the network
 *   other origins (map tiles)         not handled
 *
 * The API cache is filled when the worker activates (offline works right after a first visit)
 * and keeps its name across updates (an update never throws away the places).
 *
 * Updates install in the background and then wait. The page shows "A new version is available"
 * and sends SKIP_WAITING only when the traveler taps Reload, so files never change under a
 * running page.
 */

// Written by scripts/write-precache.ts after `next build`. Left as is, nothing is precached.
const BUILD_ID = "development";
const PRECACHE_URLS = [];
const SHELL_SHA256 = "";

const CACHE_PREFIX = "italy-planner-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`;
// Decision: the API cache is named for the response contract, not the build. Deploys change the
// build id often; the shape of /api/places and /api/meta rarely does. Bump the version (and
// lib/sw/apiCache.ts) only when the page can no longer read an older copy.
const API_CACHE = `${CACHE_PREFIX}api-v1`;
const SHELL_URL = "/";
const SWR_API_PATHS = ["/api/meta", "/api/places"];
// Decision: a navigation that has not answered in 4 s gets the cached shell. On a weak
// connection the traveler sees the app (and their last plan) instead of a blank tab.
const NAVIGATION_TIMEOUT_MS = 4000;

const OFFLINE_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>3 Days in Italy</title>" +
  "<p>You are offline, and this app is not saved on this device yet. " +
  "Connect to the internet and reload.</p></html>";

/**
 * The strategy for a request: "static", "navigation", "api-swr", "precached", or "network"
 * (not handled at all). Pure: `request` needs only method, url and mode.
 */
function routeRequest(request, origin) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "network";
  }
  if (url.origin !== origin) return "network";
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    // Decision: only the two read-only lists, fetched by the page without a query, are ever
    // cached. A plan is a POST that must reach the server every time, nothing else under /api/
    // is needed offline, and an API URL opened in the address bar always shows the live answer.
    const readOnly = request.method === "GET" && request.mode !== "navigate" && url.search === "";
    return readOnly && SWR_API_PATHS.includes(url.pathname) ? "api-swr" : "network";
  }
  if (request.method !== "GET") return "network";
  if (request.mode === "navigate") return "navigation";
  if (url.pathname.startsWith("/_next/static/")) return "static";
  return "precached";
}

/** True for a complete 200 that was not redirected. Errors and partial content are never stored. */
function isCacheable(response) {
  return (
    response.status === 200 &&
    !response.redirected &&
    (response.type === "basic" || response.type === "default")
  );
}

/**
 * True when an API reply is worth keeping for offline use: a complete 200, JSON by type and by
 * content, and a non-empty list whose items have the fields the page plans with. It stops an
 * HTML error page, a broken body, an empty list or the wrong shape replacing a good copy.
 */
async function isStorableApi(response, request) {
  if (!isCacheable(response)) return false;
  const type = response.headers.get("content-type") || "";
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(type)) return false;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return false;
  }
  if (new URL(request.url).pathname === "/api/meta") return listOf(body?.anchors, isNamedItem);
  return listOf(Array.isArray(body) ? body : body?.places, isPlaceLike);
}

function listOf(list, complete) {
  return Array.isArray(list) && list.length > 0 && list.every(complete);
}

// The fields the page cannot plan without. The page's Zod schema checks everything else, and
// removes a saved copy it rejects (lib/sw/apiCache.ts).
function isNamedItem(item) {
  return Boolean(item) && typeof item.id === "string" && typeof item.name === "string";
}

function isPlaceLike(item) {
  const numbers = [item?.lat, item?.lng, item?.durationMin];
  return isNamedItem(item) && typeof item.city === "string" && numbers.every(Number.isFinite);
}

/** A cached response, or undefined. A broken or full cache never fails the request. */
async function fromCache(cacheName, request, options) {
  try {
    const cache = await caches.open(cacheName);
    return await cache.match(request, options);
  } catch {
    return undefined;
  }
}

/** Stores a copy when `storable` accepts it. A full or broken cache never fails the request. */
async function toCache(cacheName, request, response, storable = isCacheable) {
  if (!(await storable(response, request))) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch {
    // Storage full or unavailable: the response is still served.
  }
}

async function cacheFirst(request) {
  const hit = await fromCache(SHELL_CACHE, request);
  if (hit) return hit;
  const response = await fetch(request);
  await toCache(SHELL_CACHE, request, response);
  return response;
}

async function precachedOrNetwork(request) {
  const hit = await fromCache(SHELL_CACHE, request);
  return hit ?? fetch(request);
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function offlineShell() {
  const shell = await fromCache(SHELL_CACHE, SHELL_URL);
  if (shell) return shell;
  return new Response(OFFLINE_PAGE, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function networkFirst(request) {
  let response;
  try {
    response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
  } catch {
    return offlineShell();
  }
  // Decision: a 5xx from the edge also gets the shell. A 404 is a real answer and is shown.
  // The shell is never overwritten from here, so it always matches the precached scripts.
  if (response.status >= 500) {
    const shell = await fromCache(SHELL_CACHE, SHELL_URL);
    return shell ?? response;
  }
  return response;
}

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cached = await fromCache(API_CACHE, request, { ignoreVary: true });
  const network = fetch(request).then(async (response) => {
    await toCache(API_CACHE, request, response, isStorableApi);
    return response;
  });
  if (!cached) return network;
  event.waitUntil(network.catch(() => undefined));
  return cached;
}

function respond(strategy, event) {
  if (strategy === "static") return cacheFirst(event.request);
  if (strategy === "navigation") return networkFirst(event.request);
  if (strategy === "api-swr") return staleWhileRevalidate(event);
  return precachedOrNetwork(event.request);
}

async function sha256Hex(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Decision: the shell must be the exact index.html this worker was built with. During a deploy
// the new worker can install before the edge serves the new page; an older shell would point
// at scripts this cache does not hold and break offline use. A mismatch fails the install, and
// the browser tries again on a later visit.
async function precacheShell(cache) {
  const response = await fetch(new Request(SHELL_URL, { cache: "reload" }));
  if (!response.ok) throw new Error(`Shell answered ${response.status}`);
  if (SHELL_SHA256 && (await sha256Hex(await response.clone().arrayBuffer())) !== SHELL_SHA256) {
    throw new Error("The shell is from another deploy");
  }
  await cache.put(SHELL_URL, response);
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  try {
    if (PRECACHE_URLS.includes(SHELL_URL)) await precacheShell(cache);
    // cache: "reload" skips the HTTP cache so the shell and its scripts come from one deploy.
    const rest = PRECACHE_URLS.filter((url) => url !== SHELL_URL);
    await cache.addAll(rest.map((url) => new Request(url, { cache: "reload" })));
  } catch (error) {
    // All or nothing: a failed install leaves no half-filled cache, the old worker stays in
    // charge, and the browser tries again later. This cache name is never the running one.
    await caches.delete(SHELL_CACHE);
    throw error;
  }
}

// Decision: fill the API cache once the worker is in charge. On a first visit the page fetched
// the places before the worker existed, so nothing was kept and an offline reopen had no places.
// Best effort with a deadline: a failure here must never block activation.
const WARM_TIMEOUT_MS = 8000;

async function warmApiCache() {
  await Promise.all(
    SWR_API_PATHS.map(async (path) => {
      try {
        const request = new Request(path);
        const response = await withTimeout(fetch(request), WARM_TIMEOUT_MS);
        await toCache(API_CACHE, request, response, isStorableApi);
      } catch {
        // Offline or slow: the page's own requests fill the cache later.
      }
    }),
  );
}

async function deleteOldCaches() {
  const keep = [SHELL_CACHE, API_CACHE];
  const names = await caches.keys();
  const old = names.filter((name) => name.startsWith(CACHE_PREFIX) && !keep.includes(name));
  await Promise.all(old.map((name) => caches.delete(name)));
}

self.addEventListener("install", (event) => {
  // No skipWaiting here: an update waits until the traveler chooses to reload.
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  // Decision: claim open pages. On a first install this only starts offline support for the
  // page already open; an update only activates after the traveler tapped Reload.
  event.waitUntil(
    deleteOldCaches()
      .then(() => self.clients.claim())
      .then(() => warmApiCache()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const strategy = routeRequest(event.request, self.location.origin);
  if (strategy === "network") return;
  event.respondWith(respond(strategy, event));
});
