import type { Hono } from "hono";
import { z } from "zod";
import type { ExchangeRateClient } from "../currency/client";
import type { AppEnv } from "../lib/appEnv";
import { sendError, zodDetails } from "../lib/httpErrors";

// GET /api/currency?to=USD: how many units of `to` one euro buys, and the date of the rate, or
// { available: false, reason }. Only the currencies the page offers are accepted, so junk never
// reaches Frankfurter.

const CurrencyQuery = z.object({
  to: z.enum(["USD", "GBP", "CHF", "JPY"]).default("USD"),
});

export function registerCurrencyRoute(
  app: Hono<AppEnv>,
  deps: { currency: ExchangeRateClient },
): void {
  app.get("/currency", async (c) => {
    const parsed = CurrencyQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return sendError(c, 400, "bad_request", "Invalid query", zodDetails(parsed.error));
    }

    const result = await deps.currency.getRate(parsed.data.to);
    if (result.ok) return c.json({ available: true, ...result.exchangeRate });
    return c.json({ available: false, reason: result.reason });
  });
}
