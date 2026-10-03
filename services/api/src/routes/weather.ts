import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/appEnv";
import { sendError, zodDetails } from "../lib/httpErrors";
import type { WeatherClient } from "../weather/client";

const weatherResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(["timeout", "out_of_range", "bad_response", "unavailable"]),
  forecast: z
    .object({
      date: z.string(),
      maxTempC: z.number().optional(),
      rainMm: z.number().optional(),
    })
    .optional(),
});

const WeatherQuery = z.object({
  lng: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type WeatherResponse = {
  ok: boolean;
  reason: "timeout" | "out_of_range" | "bad_response" | "unavailable";
  forecast?: {
    date: string;
    maxTempC: number | undefined;
    rainMm: number | undefined;
  };
};

export function registerWeatherRoute(app: Hono<AppEnv>, deps: { weather: WeatherClient }): void {
  app.get("/weather", async (c) => {
    const parsed = WeatherQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return sendError(c, 400, "bad_request", "Invalid Query", zodDetails(parsed.error));
    }

    const { lat, lng, date } = parsed.data;

    const result = await deps.weather.getForecast(lat, lng, date);
    if (result.ok) return c.json({ available: true, ...result.forecast });
    return c.json({ available: false, reason: result.reason });
  });
}
