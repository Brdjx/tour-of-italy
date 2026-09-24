// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtSource, loadWorker, req } from "./harness";
import { answer, installed, json, META, type Network, offline, P, URLS } from "./workerSetup";

// Offline use of the place list and form data: filled on a first visit, kept across updates, and
// never replaced by a reply the page could not use.

afterEach(() => vi.useRealTimers());

describe("offline right after the first visit, and across updates", () => {
  const api: Network = async (r) => {
    const path = new URL(r.url).pathname;
    if (path === "/api/places") return json({ places: [P("place_001")] });
    if (path === "/api/meta") return json(META);
    return new Response(`body of ${r.url}`);
  };

  it("fills the place list and form data on activate, so a first visit works offline", async () => {
    // The page fetched both before the worker existed; only the worker's own fetch keeps them.
    const { worker, setNetwork } = await installed(api);
    setNetwork(offline);
    const places = await answer(worker, req("/api/places"));
    expect(await places.json()).toEqual({ places: [P("place_001")] });
    expect(await (await answer(worker, req("/api/meta"))).json()).toEqual(META);
  });

  it("still activates and claims the page when filling the cache fails or hangs", async () => {
    vi.useFakeTimers();
    const worker = loadWorker({
      source: builtSource("b1", URLS),
      network: async (r) =>
        new URL(r.url).pathname.startsWith("/api/")
          ? new Promise<Response>(() => {})
          : new Response("x"),
    });
    await worker.dispatch("install");
    const activated = worker.dispatch("activate");
    await vi.advanceTimersByTimeAsync(8000);
    await activated;
    expect(worker.claimed.calls).toBe(1);
  });

  it("keeps the saved places when an update activates offline, so the app still opens", async () => {
    const v1 = await installed(api);
    let network: Network = api;
    const v2 = loadWorker({
      source: builtSource("b2", URLS),
      network: (r) => network(r),
      caches: v1.worker.caches,
    });
    await v2.dispatch("install"); // installed online, waiting for the traveler
    network = offline; // the tab is closed; the app is reopened in airplane mode
    await v2.dispatch("activate");
    const places = await answer(v2, req("/api/places"));
    expect(await places.json()).toEqual({ places: [P("place_001")] });
    expect(v2.caches.caches.has("italy-planner-shell-b1")).toBe(false);
  });
});

describe("a bad reply never replaces a good saved copy", () => {
  it.each([
    ["an HTML page with status 200", () => new Response("<!doctype html><p>hi</p>")],
    [
      "malformed JSON",
      () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    ],
    ["an empty place list", () => json({ places: [] })],
    ["JSON of the wrong shape", () => json({ error: "nope" })],
    [
      "places missing the fields the page plans with",
      () => json({ places: [{ id: "place_001" }] }),
    ],
  ])("keeps the good places when the API answers with %s", async (_label, bad) => {
    const good = { places: [P("place_001")] };
    const { worker, setNetwork } = await installed(async () => json(good));
    await answer(worker, req("/api/places"));
    setNetwork(async () => bad());
    await answer(worker, req("/api/places")); // served from the copy, refreshed in background
    setNetwork(offline);
    expect(await (await answer(worker, req("/api/places"))).json()).toEqual(good);
  });

  it("keeps the good form data when /api/meta answers without bases", async () => {
    const { worker, setNetwork } = await installed(async () => json(META));
    await answer(worker, req("/api/meta"));
    setNetwork(async () => json({ interests: [] }));
    await answer(worker, req("/api/meta"));
    setNetwork(offline);
    expect(await (await answer(worker, req("/api/meta"))).json()).toEqual(META);
  });
});
