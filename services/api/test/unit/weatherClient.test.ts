import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenMeteoClient } from "../../src/weather/client";

// The Open-Meteo client with fetch replaced: no network. Each test hands back one canned answer
// and checks the client turns it into the right result.

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenMeteoClient", () => {
  it("returns the day's forecast in our shape", async () => {
    answer(200, {
      daily: { time: ["2026-10-08"], temperature_2m_max: [18.2], rain_sum: [16.65] },
    });

    const result = await new OpenMeteoClient().getForecast(43.77, 11.25, "2026-10-08");

    expect(result).toEqual({
      ok: true,
      forecast: { date: "2026-10-08", maxTempC: 18.2, rainMm: 16.65 },
    });
  });

  it("reports a date past their range (their 400) as out_of_range", async () => {
    answer(400, { error: true, reason: "Parameter 'start_date' is out of allowed range" });

    const result = await new OpenMeteoClient().getForecast(43.77, 11.25, "2026-12-20");

    expect(result).toEqual({ ok: false, reason: "out_of_range" });
  });

  it("reports a network failure as unavailable instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await new OpenMeteoClient().getForecast(43.77, 11.25, "2026-10-08");

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
