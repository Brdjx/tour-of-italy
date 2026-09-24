// Estimated cost of a plan from its token counts. The prices are an estimate: they were copied
// from Anthropic's pricing table on the date below and must be checked against the current
// pricing page before any number from them is quoted. Cache pricing is not listed because the
// planner does not use prompt caching.

export const PRICING_CHECKED_ON = "2026-09-24";
export const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number; // includes any thinking tokens, which are billed as output
}

/** Standard first-party API prices per million tokens, by model family id. */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  "claude-haiku-4-5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
};

/**
 * The price for a model id, or null when the model is not in the table.
 */
// Decision: a dated snapshot id (claude-haiku-4-5-20251001) takes its family's price, the same
// prefix rule services/api/src/llm/models.ts uses for request settings. An unknown model gets no
// price rather than a guess, and the report shows "n/a".
export function priceFor(model: string): ModelPrice | null {
  for (const [family, price] of Object.entries(PRICES)) {
    if (model === family || model.startsWith(`${family}-`)) return price;
  }
  return null;
}

/** Estimated cost in US dollars, or null when the model has no price. */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const input = (usage.inputTokens / 1_000_000) * price.inputUsdPerMillion;
  const output = (usage.outputTokens / 1_000_000) * price.outputUsdPerMillion;
  return input + output;
}
