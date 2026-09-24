// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loadWorker, nav, ORIGIN, type RequestLike, req, type Strategy } from "./harness";

// The service worker's routing table, read from the shipped public/sw.js. The catastrophic
// cases: a plan (POST /api/plan) or any other API answer served from a cache, a map tile or
// another origin's file stored by us, and the app shell served for an API URL.

// Property runs are cheap but many; allow for a loaded machine during `pnpm check`.
vi.setConfig({ testTimeout: 20_000 });

const { routeRequest } = loadWorker();
const route = (request: RequestLike) => routeRequest(request, ORIGIN);

const CASES: Array<[string, RequestLike, Strategy]> = [
  ["hashed script", req("/_next/static/chunks/0cz1d0mv5g_q7.js"), "static"],
  ["hashed stylesheet", req("/_next/static/chunks/0n8kzvw2z_6as.css"), "static"],
  ["self-hosted font", req("/_next/static/media/a-s.p.woff2"), "static"],
  ["build manifest", req("/_next/static/abc/_buildManifest.js"), "static"],
  ["home page", nav("/"), "navigation"],
  ["home page with a shared plan", nav("/?p=eyJ2IjoxfQ"), "navigation"],
  ["unknown page", nav("/somewhere/else/"), "navigation"],
  ["form list", req("/api/meta"), "api-swr"],
  ["place list", req("/api/places"), "api-swr"],
  ["plan request", req("/api/plan", { method: "POST" }), "network"],
  [
    "deterministic plan request",
    req("/api/plan?mode=deterministic", { method: "POST" }),
    "network",
  ],
  ["plan fetched with GET", req("/api/plan"), "network"],
  ["health check", req("/api/health"), "network"],
  ["data notes", req("/api/data-issues"), "network"],
  ["place list with a query", req("/api/places?limit=1"), "network"],
  ["form list with a trailing slash", req("/api/meta/"), "network"],
  ["place list by HEAD", req("/api/places", { method: "HEAD" }), "network"],
  ["place list by PUT", req("/api/places", { method: "PUT" }), "network"],
  ["place list by DELETE", req("/api/places", { method: "DELETE" }), "network"],
  ["API root", req("/api"), "network"],
  ["API URL opened as a page", nav("/api/places"), "network"],
  ["API health opened as a page", nav("/api/health"), "network"],
  ["percent-encoded plan path", req("/api/%70lan", { method: "POST" }), "network"],
  ["percent-encoded meta path", req("/api/%6Deta"), "network"],
  ["dot segments into the API", req("/_next/static/../../api/plan", { method: "POST" }), "network"],
  ["POST to a static path", req("/_next/static/chunks/a.js", { method: "POST" }), "network"],
  ["map tile", req("https://tile.openstreetmap.org/12/2200/1500.png"), "network"],
  ["map tile subdomain", req("https://a.tile.openstreetmap.org/12/2200/1500.png"), "network"],
  ["other origin with our path", req("https://evil.example/_next/static/chunks/a.js"), "network"],
  ["other origin API", req("https://api.italy-planner.brdjx.com/places"), "network"],
  ["local API in development", req("http://localhost:8787/api/places"), "network"],
  ["same host over http", req("http://italy-planner.brdjx.com/_next/static/a.js"), "network"],
  ["browser extension", req("chrome-extension://abc/script.js"), "network"],
  ["unparsable URL", { url: "not a url", method: "GET" }, "network"],
  ["web app manifest", req("/manifest.webmanifest"), "precached"],
  ["app icon", req("/icons/icon-192.png"), "precached"],
  ["server component payload", req("/index.txt"), "precached"],
];

describe("routeRequest", () => {
  it.each(CASES)("routes %s to the right strategy", (_name, request, expected) => {
    expect(route(request)).toBe(expected);
  });

  it("never sends a plan request to a cache, whatever its method or query", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("POST", "post", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"),
        fc.webQueryParameters(),
        (method, query) => {
          const strategy = route(req(`/api/plan${query ? `?${query}` : ""}`, { method }));
          expect(strategy).toBe("network");
        },
      ),
      { numRuns: 300, seed: 28 },
    );
  });

  it("never caches any /api/ path other than the two read-only lists", () => {
    fc.assert(
      fc.property(
        fc.webPath(),
        fc.constantFrom("GET", "POST", "PUT", "DELETE", "HEAD"),
        fc.constantFrom("cors", "navigate", "no-cors", "same-origin"),
        (path, method, mode) => {
          const strategy = route(
            req(`/api${path.startsWith("/") ? path : `/${path}`}`, { method, mode }),
          );
          const url = new URL(`/api${path.startsWith("/") ? path : `/${path}`}`, ORIGIN);
          const allowed =
            method === "GET" &&
            mode !== "navigate" &&
            url.search === "" &&
            ["/api/meta", "/api/places"].includes(url.pathname);
          expect(strategy).toBe(allowed ? "api-swr" : "network");
        },
      ),
      { numRuns: 500, seed: 29 },
    );
  });

  it("never handles a request for another origin", () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true }), (url) => {
        fc.pre(new URL(url).origin !== ORIGIN);
        expect(route({ url, method: "GET", mode: "cors" })).toBe("network");
        expect(route({ url, method: "GET", mode: "navigate" })).toBe("network");
      }),
      { numRuns: 300, seed: 30 },
    );
  });

  it("only ever answers with one of the five known strategies", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ maxLength: 8 }),
        fc.string({ maxLength: 12 }),
        (url, method, mode) => {
          expect(["static", "navigation", "api-swr", "precached", "network"]).toContain(
            route({ url, method, mode }),
          );
        },
      ),
      { numRuns: 300, seed: 31 },
    );
  });
});
