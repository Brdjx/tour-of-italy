// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtSource, loadWorker, nav, req } from "./harness";
import {
  API,
  answer,
  installed,
  json,
  META,
  offline,
  P,
  SHELL_HTML,
  sha256,
  URLS,
} from "./workerSetup";

// The worker's behaviour, run from the shipped public/sw.js with fake caches and network:
// install, activate, the update handshake, and each fetch strategy, including the failures a
// traveler would feel (a cached plan, a blank page offline, a broken cache taking the site down).

afterEach(() => vi.useRealTimers());

describe("install and activate", () => {
  it("precaches every listed file into this build's cache, bypassing the HTTP cache", async () => {
    const { worker } = await installed();
    const shell = worker.caches.caches.get("italy-planner-shell-b1");
    expect([...(shell?.entries.keys() ?? [])].sort()).toEqual(
      URLS.map((url) => `https://italy-planner.brdjx.com${url}`).sort(),
    );
    const precacheRequests = (worker.fetchCalls as unknown as Request[]).filter(
      (request) => !new URL(request.url).pathname.startsWith("/api/"),
    );
    expect(precacheRequests.length).toBe(URLS.length);
    expect(precacheRequests.every((request) => request.cache === "reload")).toBe(true);
  });

  it("fails the install and stores nothing when one file cannot be fetched", async () => {
    const worker = loadWorker({
      source: builtSource("b1", URLS),
      network: async (r) =>
        r.url.endsWith(".js") ? new Response("gone", { status: 404 }) : new Response("ok"),
    });
    await expect(worker.dispatch("install")).rejects.toThrow();
    expect(worker.caches.caches.get("italy-planner-shell-b1")?.entries.size ?? 0).toBe(0);
  });

  it("refuses to install when the edge still serves another deploy's page as the shell", async () => {
    const expected = await sha256(SHELL_HTML);
    const stale = loadWorker({
      source: builtSource("b1", URLS, expected),
      network: async (r) => new Response(r.url.endsWith("/") ? "<title>older deploy</title>" : "x"),
    });
    await expect(stale.dispatch("install")).rejects.toThrow(/another deploy/);
    expect(stale.caches.caches.get("italy-planner-shell-b1")?.entries.size ?? 0).toBe(0);
    const current = loadWorker({
      source: builtSource("b1", URLS, expected),
      network: async (r) => new Response(r.url.endsWith("/") ? SHELL_HTML : "x"),
    });
    await current.dispatch("install");
    expect(current.caches.caches.get("italy-planner-shell-b1")?.entries.size).toBe(URLS.length);
  });

  it("never skips waiting on install, so an update cannot swap files under an open page", async () => {
    const { worker } = await installed();
    expect(worker.skipWaiting.calls).toBe(0);
  });

  it("deletes older builds' caches on activate and leaves caches it does not own", async () => {
    const worker = loadWorker({ source: builtSource("b2", URLS) });
    for (const name of ["italy-planner-shell-b1", "italy-planner-api-b1", "someone-else"]) {
      await worker.caches.open(name);
    }
    await worker.dispatch("install");
    await worker.dispatch("activate");
    expect([...worker.caches.caches.keys()].sort()).toEqual([
      "italy-planner-shell-b2",
      "someone-else",
    ]);
    expect(worker.claimed.calls).toBe(1);
  });

  it("takes over only when the page sends SKIP_WAITING", async () => {
    const { worker } = await installed();
    await worker.dispatch("message", { type: "hello" });
    await worker.dispatch("message", null);
    expect(worker.skipWaiting.calls).toBe(0);
    await worker.dispatch("message", { type: "SKIP_WAITING" });
    expect(worker.skipWaiting.calls).toBe(1);
  });
});

describe("POST /api/plan and other API calls", () => {
  it("never answers a plan request, even when a cache holds a response for that URL", async () => {
    const { worker } = await installed();
    const apiCache = await worker.caches.open("italy-planner-api-b1");
    await apiCache.put(req("/api/plan"), json({ poisoned: true }));
    for (const request of [
      req("/api/plan", { method: "POST" }),
      req("/api/plan?mode=deterministic", { method: "POST" }),
      req("/api/health"),
      req("/api/data-issues"),
    ]) {
      expect(worker.dispatchFetch(request).responded).toBeNull();
    }
  });

  it("never tries to store a plan request anywhere", async () => {
    const { worker } = await installed(async () => json({ days: [] }));
    for (let i = 0; i < 5; i += 1) worker.dispatchFetch(req("/api/plan", { method: "POST" }));
    const attempts = [...worker.caches.caches.values()].flatMap((cache) => cache.putAttempts);
    expect(attempts.filter((attempt) => attempt.includes("/api/plan"))).toEqual([]);
  });

  it("leaves map tiles from OpenStreetMap to the browser", async () => {
    const { worker } = await installed();
    const tile = worker.dispatchFetch(req("https://tile.openstreetmap.org/5/17/11.png"));
    expect(tile.responded).toBeNull();
  });
});

describe("GET /api/places and /api/meta (stale-while-revalidate)", () => {
  it("serves the network answer the first time and keeps a copy", async () => {
    const { worker } = await installed(async () => json({ places: [P("v1")] }));
    const response = await answer(worker, req("/api/places"));
    expect(await response.json()).toEqual({ places: [P("v1")] });
    expect(worker.caches.caches.get(API)?.entries.size).toBe(1);
  });

  it("answers from the copy at once and refreshes it in the background", async () => {
    const { worker, setNetwork } = await installed(async () => json({ places: [P("v1")] }));
    await answer(worker, req("/api/places"));
    setNetwork(async () => json({ places: [P("v2")] }));
    expect(await (await answer(worker, req("/api/places"))).json()).toEqual({ places: [P("v1")] });
    expect(await (await answer(worker, req("/api/places"))).json()).toEqual({ places: [P("v2")] });
  });

  it("serves the copy offline and the background refresh fails quietly", async () => {
    const { worker, setNetwork } = await installed(async () => json(META));
    await answer(worker, req("/api/meta"));
    setNetwork(offline);
    const response = await answer(worker, req("/api/meta"));
    expect(await response.json()).toEqual(META);
  });

  it("fails like the network when offline with no copy, so the page shows its load error", async () => {
    const { worker, setNetwork } = await installed();
    setNetwork(offline);
    const event = worker.dispatchFetch(req("/api/places"));
    await expect(event.responded).rejects.toThrow("Failed to fetch");
  });

  it("never stores an error answer or lets it replace a good copy", async () => {
    const { worker, setNetwork } = await installed(async () => json({ places: [P("good")] }));
    await answer(worker, req("/api/places"));
    setNetwork(async () => json({ error: { code: "INTERNAL" } }, 500));
    await answer(worker, req("/api/places"));
    setNetwork(offline);
    expect(await (await answer(worker, req("/api/places"))).json()).toEqual({
      places: [P("good")],
    });
  });
});

describe("hashed static files (cache first)", () => {
  it("serves a precached script without touching the network", async () => {
    const { worker } = await installed();
    const before = worker.fetchCalls.length;
    const response = await answer(worker, req("/_next/static/chunks/app.js"));
    expect(await response.text()).toContain("app.js");
    expect(worker.fetchCalls.length).toBe(before);
  });

  it("fetches and keeps a hashed file it does not have yet, but never a 404", async () => {
    const { worker, setNetwork } = await installed();
    await answer(worker, req("/_next/static/chunks/late.js"));
    setNetwork(async () => new Response("missing", { status: 404 }));
    await answer(worker, req("/_next/static/chunks/missing.js"));
    const keys = [...(worker.caches.caches.get("italy-planner-shell-b1")?.entries.keys() ?? [])];
    expect(keys.some((key) => key.endsWith("late.js"))).toBe(true);
    expect(keys.some((key) => key.endsWith("missing.js"))).toBe(false);
  });
});

describe("navigations (network first, shell offline)", () => {
  it("shows the live page when the network answers and never rewrites the cached shell", async () => {
    const { worker, setNetwork } = await installed(async () => new Response(SHELL_HTML));
    setNetwork(async () => new Response("<title>new deploy</title>"));
    expect(await (await answer(worker, nav("/"))).text()).toBe("<title>new deploy</title>");
    setNetwork(offline);
    expect(await (await answer(worker, nav("/"))).text()).toBe(SHELL_HTML);
  });

  it("opens the cached shell offline, including for a shared-plan link", async () => {
    const { worker, setNetwork } = await installed(async () => new Response(SHELL_HTML));
    setNetwork(offline);
    expect(await (await answer(worker, nav("/?p=eyJ2IjoxfQ"))).text()).toBe(SHELL_HTML);
  });

  it("opens the cached shell when the edge answers with a 5xx, but shows a real 404", async () => {
    const { worker, setNetwork } = await installed(async () => new Response(SHELL_HTML));
    setNetwork(async () => new Response("bad gateway", { status: 502 }));
    expect(await (await answer(worker, nav("/"))).text()).toBe(SHELL_HTML);
    setNetwork(async () => new Response("not found", { status: 404 }));
    expect((await answer(worker, nav("/nope/"))).status).toBe(404);
  });

  it("opens the cached shell when the network hangs past the navigation timeout", async () => {
    const { worker, setNetwork } = await installed(async () => new Response(SHELL_HTML));
    vi.useFakeTimers();
    setNetwork(() => new Promise<Response>(() => {}));
    const event = worker.dispatchFetch(nav("/"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await (await event.responded)?.text()).toBe(SHELL_HTML);
  });

  it("shows a plain offline page, not a browser error, when nothing was saved yet", async () => {
    const worker = loadWorker({ network: offline });
    const response = await answer(worker, nav("/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("You are offline");
  });
});

describe("a broken cache never takes the site down", () => {
  it("still serves static files, pages, and place lists from the network", async () => {
    const { worker } = await installed(
      async (r) => new Response(`live ${new URL(r.url).pathname}`),
    );
    worker.caches.broken = true;
    expect(await (await answer(worker, req("/_next/static/chunks/x.js"))).text()).toBe(
      "live /_next/static/chunks/x.js",
    );
    expect(await (await answer(worker, nav("/"))).text()).toBe("live /");
    expect(await (await answer(worker, req("/api/places"))).text()).toBe("live /api/places");
    expect(await (await answer(worker, req("/icons/icon-192.png"))).text()).toBe(
      "live /icons/icon-192.png",
    );
  });
});
