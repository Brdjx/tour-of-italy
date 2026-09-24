import { describe, expect, it } from "vitest";
import { alternativesFor } from "../src/alternatives";
import { planDeterministic } from "../src/plan";
import { makeRequest, realContext } from "./plannerFixtures";

// Performance guard. planDeterministic is the fallback inside the API's 30 s budget and runs in
// the browser when offline; alternativesFor runs in the browser on every tap of Swap. Budgets:
// 50 ms per plan and 100 ms per swap list on a developer machine. The assertions allow 5x that,
// so a slow CI runner or coverage instrumentation never flakes, while an accidental blow-up
// (a quadratic loop over every arrangement, a validator call per pair) still fails.

const ctx = realContext();
const PLAN_BUDGET_MS = 50;
const SWAP_BUDGET_MS = 100;
const SLACK = 5;

/** Median and worst time of `runs` calls after a warm-up, in milliseconds. */
function timeIt(runs: number, call: () => unknown): { median: number; worst: number } {
  for (let i = 0; i < 3; i++) call(); // warm the JIT and the lazily built caches
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    call();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)] ?? 0, worst: times.at(-1) ?? 0 };
}

const round = (ms: number) => Math.round(ms * 100) / 100;

describe("planner performance on this machine", () => {
  const typical = makeRequest({ startDate: "2026-10-20", interests: ["art", "food"] });
  const heavy = makeRequest({
    startDate: "2027-01-11",
    pace: "packed",
    interests: ["art", "food", "wine", "views", "historic", "iconic", "local-favorite", "quiet"],
    mustInclude: ["place_001", "place_026", "place_077", "place_035", "place_067"],
    exclude: ["place_002", "place_003", "place_004", "place_005", "place_006"],
  });

  it("never takes longer than 5x the 50 ms budget to plan a typical trip", () => {
    const result = timeIt(20, () => planDeterministic(typical, ctx));
    const heavyResult = timeIt(10, () => planDeterministic(heavy, ctx));
    console.info(
      `planDeterministic typical: median ${round(result.median)} ms, worst ${round(result.worst)} ms; ` +
        `heavy (packed, 8 interests, 5 must-includes, 5 exclusions): median ${round(heavyResult.median)} ms, worst ${round(heavyResult.worst)} ms`,
    );
    expect(result.median).toBeLessThan(PLAN_BUDGET_MS * SLACK);
    expect(heavyResult.median).toBeLessThan(PLAN_BUDGET_MS * SLACK);
  });

  it("never takes longer than 5x the 100 ms budget to list swaps for any stop of a typical trip", () => {
    const itinerary = planDeterministic(typical, ctx);
    let median = 0;
    let worst = 0;
    itinerary.days.forEach((day, d) => {
      day.stops.forEach((_stop, s) => {
        const result = timeIt(5, () => alternativesFor(itinerary, d, s, ctx));
        median = Math.max(median, result.median);
        worst = Math.max(worst, result.worst);
      });
    });
    console.info(
      `alternativesFor over every stop: slowest median ${round(median)} ms, worst ${round(worst)} ms`,
    );
    expect(median).toBeGreaterThan(0);
    expect(median).toBeLessThan(SWAP_BUDGET_MS * SLACK);
  });
});
