import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthStatus, HealthView } from "../components/HealthStatus";
import { resolveApiBase } from "../lib/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resolveApiBase", () => {
  it("uses the configured base without a trailing slash", () => {
    expect(resolveApiBase("https://example.test/", "production")).toBe("https://example.test");
  });

  it("keeps an explicit empty base (same origin)", () => {
    expect(resolveApiBase("", "development")).toBe("");
  });

  it("falls back to the local API in dev and same origin in builds", () => {
    expect(resolveApiBase(undefined, "development")).toBe("http://localhost:8787");
    expect(resolveApiBase(undefined, "production")).toBe("");
  });
});

describe("HealthView", () => {
  it("shows version and commit when the API is up", () => {
    render(
      <HealthView
        state={{ status: "ok", health: { ok: true, version: "1.2.3", commit: "abc" } }}
      />,
    );

    expect(screen.getByText(/Version 1.2.3, commit abc/)).toBeTruthy();
  });

  it("tells the user what to do when the API is down", () => {
    render(<HealthView state={{ status: "error", message: "timeout" }} />);

    expect(screen.getByText(/Start it with pnpm dev/)).toBeTruthy();
  });
});

describe("HealthStatus", () => {
  it("fetches /api/health and renders the result", async () => {
    const body = { ok: true, version: "0.1.0", commit: "local" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<HealthStatus />);

    expect(await screen.findByText(/API is up/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.anything());
  });
});
