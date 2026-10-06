import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/appEnv";
import { sendError, zodDetails } from "../lib/httpErrors";
import type { WeatherClient } from "../weather/client";

// GET /api/weather?lat=&lng=&date=: one day's forecast, or { available: false, reason }.
// A missing forecast is a 200, not an error: the request was fine, there is just nothing to show,
// and the plan never waits on the weather.

const WeatherQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function registerWeatherRoute(app: Hono<AppEnv>, deps: { weather: WeatherClient }): void {
  app.get("/weather", async (c) => {
    const parsed = WeatherQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return sendError(c, 400, "bad_request", "Invalid query", zodDetails(parsed.error));
    }
    const { lat, lng, date } = parsed.data;

    const result = await deps.weather.getForecast(lat, lng, date);
    if (result.ok) return c.json({ available: true, ...result.forecast });
    return c.json({ available: false, reason: result.reason });
  });
}
