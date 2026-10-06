import { z } from "zod";

// Euro exchange rates from Frankfurter (free, no key). Rates are published on working days, so
// `asOf` can be a day or two old: the caller shows it. Every outcome is a value, never an
// exception.

export type ExchangeRate = { to: string; rate: number; asOf: string }; // 1 EUR = rate × `to`

export type ExchangeResult =
  | { ok: true; exchangeRate: ExchangeRate }
  | { ok: false; reason: "timeout" | "unknown_currency" | "bad_response" | "unavailable" };

export interface ExchangeRateClient {
  getRate(to?: string): Promise<ExchangeResult>;
}

// What Frankfurter sends: {"amount":1.0,"base":"EUR","date":"2026-10-02","rates":{"USD":1.1225}}
const FrankfurterLatest = z.object({
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

export class FrankfurterClient implements ExchangeRateClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 3000) {
    this.timeoutMs = timeoutMs;
  }

  async getRate(to = "USD"): Promise<ExchangeResult> {
    const params = new URLSearchParams({ base: "EUR", symbols: to });

    // 1. The call: only network failures land here.
    let response: Response;
    try {
      response = await fetch(`https://api.frankfurter.dev/v1/latest?${params}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "unavailable" };
    }

    // 2. Their status: 404 means they don't know that currency; other errors mean they are down.
    if (response.status === 404) return { ok: false, reason: "unknown_currency" };
    if (!response.ok) return { ok: false, reason: "unavailable" };

    // 3. Their shape.
    const parsed = FrankfurterLatest.safeParse(await response.json());
    if (!parsed.success) return { ok: false, reason: "bad_response" };

    // 4. Our currency, which a record cannot promise is there.
    const rate = parsed.data.rates[to];
    if (rate === undefined) return { ok: false, reason: "bad_response" };

    return { ok: true, exchangeRate: { to, rate, asOf: parsed.data.date } };
  }
}
