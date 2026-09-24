import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING_CHECKED_ON, PRICING_SOURCE, priceFor } from "../src/pricing";

// A wrong price table makes the cost column quietly wrong, so the arithmetic, the model lookup,
// and the "this is an estimate from a date" labelling are each pinned.

describe("pricing", () => {
  it("charges Sonnet 5 $2 in and $10 out per million tokens, Haiku 4.5 $1 and $5", () => {
    const million = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd("claude-sonnet-5", million)).toBeCloseTo(12, 10);
    expect(estimateCostUsd("claude-haiku-4-5", million)).toBeCloseTo(6, 10);
  });

  it("prices a typical plan in fractions of a cent, input and output separately", () => {
    // 5,000 input tokens at $2/M = $0.010; 800 output tokens at $10/M = $0.008.
    const cost = estimateCostUsd("claude-sonnet-5", { inputTokens: 5000, outputTokens: 800 });
    expect(cost).toBeCloseTo(0.018, 10);
  });

  it("prices a dated snapshot id like its family", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
  });

  it("gives no price, not a guess, for a model it does not know", () => {
    expect(priceFor("claude-sonnet-50")).toBeNull();
    expect(priceFor("fixture:valid")).toBeNull();
    expect(estimateCostUsd("simulated", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("says when the prices were checked and where to check them again", () => {
    expect(PRICING_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING_SOURCE).toMatch(/^https:\/\/.+pricing/);
  });
});
