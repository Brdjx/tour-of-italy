import { z } from "zod";

// One day's forecast from Open-Meteo (free, no key). Every outcome is a value, never an exception:
// network, status, shape and missing data each map to one reason, and Open-Meteo's field names
// never leave this file.

export type Forecast = { date: string; maxTempC: number; rainMm: number };

export type WeatherResult =
  | { ok: true; forecast: Forecast }
  | { ok: false; reason: "timeout" | "out_of_range" | "bad_response" | "unavailable" };

export interface WeatherClient {
  getForecast(lat: number, lng: number, date: string): Promise<WeatherResult>;
}

// What Open-Meteo sends on success. Their daily values can be null.
const OpenMeteoDaily = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number().nullable()),
    rain_sum: z.array(z.number().nullable()),
  }),
});

export class OpenMeteoClient implements WeatherClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 3000) {
    this.timeoutMs = timeoutMs;
  }

  async getForecast(lat: number, lng: number, date: string): Promise<WeatherResult> {
    // Decision: ask for exactly this day, in Rome's time zone. Without start and end dates
    // Open-Meteo sends only the next 7 days; without the time zone the day runs on GMT.
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      daily: "temperature_2m_max,rain_sum",
      timezone: "Europe/Rome",
      start_date: date,
      end_date: date,
    });

    // 1. The call: only network failures land here.
    let response: Response;
    try {
      response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "unavailable" };
    }

    // 2. Their status: 400 is a date outside their range (today + 15 days); other errors mean
    // they are down.
    if (response.status === 400) return { ok: false, reason: "out_of_range" };
    if (!response.ok) return { ok: false, reason: "unavailable" };

    // 3. Their shape: never trust it.
    const parsed = OpenMeteoDaily.safeParse(await response.json());
    if (!parsed.success) return { ok: false, reason: "bad_response" };

    // 4. Our day, with no nulls.
    const daily = parsed.data.daily;
    const index = daily.time.indexOf(date);
    if (index === -1) return { ok: false, reason: "out_of_range" };
    const maxTempC = daily.temperature_2m_max[index];
    const rainMm = daily.rain_sum[index];
    if (maxTempC == null || rainMm == null) return { ok: false, reason: "bad_response" };

    return { ok: true, forecast: { date, maxTempC, rainMm } };
  }
}
