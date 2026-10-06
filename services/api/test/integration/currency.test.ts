import { describe, expect, it } from "vitest";
import type { ExchangeRateClient, ExchangeResult } from "../../src/currency/client";
import { makeApp } from "../helpers/app";

// GET /api/currency through the whole app, with a fake ExchangeRateClient: no network.

function fakeCurrency(result: ExchangeResult): ExchangeRateClient {
  return { getRate: async () => result };
}

describe("GET /api/currency", () => {
  it("returns the dollar rate by default", async () => {
    const { app } = makeApp({
      currency: fakeCurrency({
        ok: true,
        exchangeRate: { to: "USD", rate: 1.1225, asOf: "2026-10-02" },
      }),
    });

    const res = await app.request("/api/currency");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      to: "USD",
      rate: 1.1225,
      asOf: "2026-10-02",
    });
  });

  it("answers 200 with available false when there is no rate", async () => {
    const { app } = makeApp({ currency: fakeCurrency({ ok: false, reason: "unavailable" }) });

    const res = await app.request("/api/currency?to=GBP");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: "unavailable" });
  });

  it("refuses a currency the page doesn't offer with 400", async () => {
    const { app } = makeApp({ currency: fakeCurrency({ ok: false, reason: "unavailable" }) });

    const res = await app.request("/api/currency?to=XYZ");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});
