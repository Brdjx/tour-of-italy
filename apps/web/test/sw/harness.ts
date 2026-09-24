import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Runs the real public/sw.js in a node:vm sandbox with fake caches, fetch, and clients, so the
// tests exercise the exact file the browser installs, not a copy of its logic.

export const ORIGIN = "https://italy-planner.brdjx.com";
export const SW_PATH = fileURLToPath(new URL("../../public/sw.js", import.meta.url));

export type Strategy = "static" | "navigation" | "api-swr" | "precached" | "network";

/** The fields of a Request the worker reads. `mode: "navigate"` cannot be built with new Request. */
export interface RequestLike {
  url: string;
  method: string;
  mode?: string;
}

export function req(path: string, init: { method?: string; mode?: string } = {}): RequestLike {
  const url = /^[a-z-]+:/.test(path) ? path : `${ORIGIN}${path}`;
  return { url, method: init.method ?? "GET", mode: init.mode ?? "cors" };
}

export const nav = (path: string) => req(path, { mode: "navigate" });

function keyOf(request: RequestLike | string): string {
  return typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
}

/** Cache API subset with the browser's rules: only GET requests match or can be stored. */
export class FakeCache {
  readonly entries = new Map<string, Response>();
  readonly putAttempts: string[] = [];
  constructor(private readonly fetcher: (request: RequestLike) => Promise<Response>) {}

  async match(request: RequestLike | string): Promise<Response | undefined> {
    if (typeof request !== "string" && request.method !== "GET") return undefined;
    return this.entries.get(keyOf(request))?.clone();
  }

  async put(request: RequestLike | string, response: Response): Promise<void> {
    this.putAttempts.push(
      typeof request === "string" ? `GET ${request}` : `${request.method} ${request.url}`,
    );
    if (typeof request !== "string" && request.method !== "GET") {
      throw new TypeError("Request method is not GET");
    }
    this.entries.set(keyOf(request), response);
  }

  async addAll(requests: RequestLike[]): Promise<void> {
    const fetched: Array<[string, Response]> = [];
    for (const request of requests) {
      const response = await this.fetcher(request);
      if (!response.ok) throw new TypeError(`addAll: ${response.status} for ${request.url}`);
      fetched.push([keyOf(request), response]);
    }
    for (const [key, response] of fetched) this.entries.set(key, response);
  }
}

export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  broken = false; // every call rejects, like blocked or corrupted storage
  constructor(private readonly fetcher: (request: RequestLike) => Promise<Response>) {}

  async open(name: string): Promise<FakeCache> {
    if (this.broken) throw new Error("storage unavailable");
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(this.fetcher);
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    if (this.broken) throw new Error("storage unavailable");
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

export interface FetchEventLike {
  request: RequestLike;
  responded: Promise<Response> | null;
  waits: Promise<unknown>[];
}

export interface Worker {
  routeRequest: (request: RequestLike, origin: string) => Strategy;
  constants: {
    BUILD_ID: string;
    PRECACHE_URLS: string[];
    SHELL_SHA256: string;
    SHELL_CACHE: string;
    API_CACHE: string;
  };
  caches: FakeCacheStorage;
  fetch: (request: RequestLike) => Promise<Response>;
  fetchCalls: RequestLike[];
  skipWaiting: { calls: number };
  claimed: { calls: number };
  /** Dispatches a fetch event; `responded` is null when the worker left it to the browser. */
  dispatchFetch: (request: RequestLike) => FetchEventLike;
  dispatch: (type: "install" | "activate" | "message", data?: unknown) => Promise<void>;
}

export interface WorkerOptions {
  source?: string;
  network?: (request: RequestLike) => Promise<Response>;
  caches?: FakeCacheStorage; // share one browser's storage between two worker versions
}

/** Loads sw.js into a fresh sandbox. `network` answers the worker's fetch calls. */
export function loadWorker(options: WorkerOptions = {}): Worker {
  const source = options.source ?? readFileSync(SW_PATH, "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const fetchCalls: RequestLike[] = [];
  const network = options.network ?? (async () => new Response("ok"));
  const fetcher = (request: RequestLike) => {
    fetchCalls.push(request);
    return network(request);
  };
  const cacheStorage = options.caches ?? new FakeCacheStorage(fetcher);
  const skipWaiting = { calls: 0 };
  const claimed = { calls: 0 };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: async () => {
      skipWaiting.calls += 1;
    },
    clients: {
      claim: async () => {
        claimed.calls += 1;
      },
    },
  };
  const context = vm.createContext({
    self,
    caches: cacheStorage,
    fetch: fetcher,
    // A worker resolves relative URLs against its own location; Node's Request has no base.
    Request: class extends Request {
      constructor(input: string | Request, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init);
      }
    },
    Response,
    URL,
    crypto: globalThis.crypto,
    // Looked up on every call, so vi.useFakeTimers() also drives the worker's timers.
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  vm.runInContext(source, context, { filename: "sw.js" });
  const constants = vm.runInContext(
    "({ BUILD_ID, PRECACHE_URLS, SHELL_SHA256, SHELL_CACHE, API_CACHE })",
    context,
  ) as Worker["constants"];
  const listener = (type: string) => {
    const found = listeners.get(type);
    if (!found) throw new Error(`sw.js has no ${type} listener`);
    return found;
  };

  return {
    routeRequest: context.routeRequest as Worker["routeRequest"],
    constants,
    caches: cacheStorage,
    fetch: fetcher,
    fetchCalls,
    skipWaiting,
    claimed,
    dispatchFetch(request) {
      const event: FetchEventLike & {
        respondWith: (p: Promise<Response>) => void;
        waitUntil: (p: Promise<unknown>) => void;
      } = {
        request,
        responded: null,
        waits: [],
        respondWith(p) {
          event.responded = Promise.resolve(p);
        },
        waitUntil(p) {
          event.waits.push(p);
        },
      };
      listener("fetch")(event);
      return event;
    },
    async dispatch(type, data) {
      const waits: Promise<unknown>[] = [];
      listener(type)({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
  };
}

/** sw.js as the post-build step writes it: build id, precache list, and optional shell hash. */
export function builtSource(buildId: string, urls: string[], shellSha256 = ""): string {
  return readFileSync(SW_PATH, "utf8")
    .replace(/^const BUILD_ID = .*$/m, () => `const BUILD_ID = ${JSON.stringify(buildId)};`)
    .replace(/^const PRECACHE_URLS = .*$/m, () => `const PRECACHE_URLS = ${JSON.stringify(urls)};`)
    .replace(/^const SHELL_SHA256 = .*$/m, () => `const SHELL_SHA256 = "${shellSha256}";`);
}
