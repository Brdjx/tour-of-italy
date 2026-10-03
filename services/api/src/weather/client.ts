import { z } from "zod";

export type Forecast = { date: string; maxTempC: number | undefined; rainMm: number | undefined };

export interface WeatherClient {
  getForecast(lat: number, lng: number, date: string): Promise<WeatherResult>;
}

export type WeatherResult =
  | { ok: true; forecast: Forecast }
  | { ok: false; reason: "timeout" | "out_of_range" | "bad_response" | "unavailable" };

const OpenMeteoDaily = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number()),
    rain_sum: z.array(z.number()),
  }),
});

export class OpenMeteoClient implements WeatherClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 3000) {
    this.timeoutMs = timeoutMs;
  }

  async getForecast(lat: number, lng: number, date: string): Promise<WeatherResult> {
    let response: Response;
    try {
      response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,rain_sum&timezone=auto`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "unavailable" };
    }

    if (response.status === 400) return { ok: false, reason: "out_of_range" };
    if (!response.ok) return { ok: false, reason: "bad_response" };

    const parsed = OpenMeteoDaily.safeParse(await response.json());

    if (!parsed.success) return { ok: false, reason: "bad_response" };

    const daily = parsed.data.daily;
    const index = daily.time.indexOf(date);
    if (index === -1) return { ok: false, reason: "out_of_range" };

    const maxTempC: number | undefined = daily.temperature_2m_max[index];
    const rainMm: number | undefined = daily.rain_sum[index];
    if (maxTempC === null || rainMm === null) return { ok: false, reason: "bad_response" };

    return { ok: true, forecast: { date, maxTempC, rainMm } };
  }
}
