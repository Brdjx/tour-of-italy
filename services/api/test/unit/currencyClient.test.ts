import { afterEach, describe, expect, it, vi } from "vitest";
import { FrankfurterClient } from "../../src/currency/client";

// The Frankfurter client with fetch replaced: no network.

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function fail(error: Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw error;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FrankfurterClient", () => {
  it("returns the rate and its date, in dollars by default", async () => {
    answer(200, { amount: 1, base: "EUR", date: "2026-10-02", rates: { USD: 1.1225 } });

    const result = await new FrankfurterClient().getRate();

    expect(result).toEqual({
      ok: true,
      exchangeRate: { to: "USD", rate: 1.1225, asOf: "2026-10-02" },
    });
  });

  it("reports a currency they don't know (their 404) as unknown_currency", async () => {
    answer(404, { message: "not found" });

    expect(await new FrankfurterClient().getRate("XYZ")).toEqual({
      ok: false,
      reason: "unknown_currency",
    });
  });

  it("reports their server errors as unavailable", async () => {
    answer(503, {});

    expect(await new FrankfurterClient().getRate()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports a wrong shape, or a missing currency, as bad_response", async () => {
    answer(200, { nope: true });
    expect(await new FrankfurterClient().getRate()).toEqual({ ok: false, reason: "bad_response" });

    answer(200, { date: "2026-10-02", rates: { GBP: 0.85 } });
    expect(await new FrankfurterClient().getRate("USD")).toEqual({
      ok: false,
      reason: "bad_response",
    });
  });

  it("tells a timeout apart from a network failure", async () => {
    fail(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await new FrankfurterClient().getRate()).toEqual({ ok: false, reason: "timeout" });

    fail(new TypeError("fetch failed"));
    expect(await new FrankfurterClient().getRate()).toEqual({ ok: false, reason: "unavailable" });
  });
});
