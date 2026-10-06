import { describe, expect, it } from "vitest";
import type { WeatherClient, WeatherResult } from "../../src/weather/client";
import { makeApp } from "../helpers/app";

// GET /api/weather through the whole app, with a fake WeatherClient passed in through makeApp:
// no network, and every answer is chosen by the test.

function fakeWeather(result: WeatherResult): WeatherClient {
  return { getForecast: async () => result };
}

describe("GET /api/weather", () => {
  it("returns the forecast when there is one", async () => {
    const { app } = makeApp({
      weather: fakeWeather({
        ok: true,
        forecast: { date: "2026-10-08", maxTempC: 18.2, rainMm: 16.65 },
      }),
    });

    const res = await app.request("/api/weather?lat=43.77&lng=11.25&date=2026-10-08");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      date: "2026-10-08",
      maxTempC: 18.2,
      rainMm: 16.65,
    });
  });

  it("answers 200 with available false when there is no forecast, never a 500", async () => {
    const { app } = makeApp({ weather: fakeWeather({ ok: false, reason: "unavailable" }) });

    const res = await app.request("/api/weather?lat=43.77&lng=11.25&date=2026-10-08");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: "unavailable" });
  });

  it("refuses a bad query with 400 before calling the weather service", async () => {
    let called = false;
    const { app } = makeApp({
      weather: {
        getForecast: async () => {
          called = true;
          return { ok: false, reason: "unavailable" };
        },
      },
    });

    const res = await app.request("/api/weather?lat=999&lng=11.25&date=2026-10-08");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(called).toBe(false);
  });
});
