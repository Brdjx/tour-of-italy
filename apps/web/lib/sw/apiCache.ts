// The page's side of the service worker's API cache (public/sw.js, API_CACHE). When a cached
// /api/places or /api/meta reply fails the page's own checks, the page removes it, so a copy it
// cannot read is never served again (online or offline) and the next request goes to the network.

/** Must match API_CACHE in public/sw.js (a test checks they agree). */
export const API_CACHE_NAME = "italy-planner-api-v1";

type CacheStorageLike = Pick<CacheStorage, "open">;

function browserCaches(): CacheStorageLike | null {
  try {
    return typeof caches === "undefined" ? null : caches;
  } catch {
    return null; // some private modes throw on access
  }
}

/** Deletes the cached replies for `paths`. Never throws; does nothing without Cache Storage. */
export async function forgetCachedApi(
  paths: readonly string[],
  storage: CacheStorageLike | null = browserCaches(),
): Promise<void> {
  if (!storage) return;
  try {
    const cache = await storage.open(API_CACHE_NAME);
    await Promise.all(paths.map((path) => cache.delete(path)));
  } catch {
    // Blocked or broken storage: there is nothing cached to serve either.
  }
}
