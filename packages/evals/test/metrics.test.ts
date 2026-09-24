import type { Shortlist } from "@italy/api/plan/candidates";
import { type Itinerary, TripRequestSchema } from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  firstAnswerMustInclude,
  isFinalValid,
  mean,
  type PlanShape,
  percentile,
  planShape,
  preferenceMatch,
  rate,
} from "../src/metrics";
import type { CallRecord } from "../src/recording";
import { summarize } from "../src/summary";
import { ctx, measure, plan } from "./helpers";

// The metrics are the numbers the write-up quotes. Each is computed here on inputs built by hand,
// so an off-by-one, a meal counted as a visit, or a missing value averaged as zero shows up.

const stop = (placeId: string, role: "visit" | "lunch" | "dinner", travel: number) => ({
  placeId,
  start: 600,
  end: 660,
  travelFromPrevMin: travel,
  role,
});

/** Four visits (two tagged food) and a food lunch, over two bases. Times are not realistic. */
function handBuilt(interests: string[] = ["food"]): Itinerary {
  const request = TripRequestSchema.parse({ startDate: "2026-10-13", pace: "balanced", interests });
  return {
    request,
    days: [
      {
        date: "2026-10-13",
        anchorId: "rome",
        transferMin: 0,
        stops: [
          stop("place_001", "visit", 10),
          stop("place_003", "lunch", 20),
          stop("place_006", "visit", 5),
        ],
        returnTravelMin: 15,
      },
      {
        date: "2026-10-14",
        anchorId: "rome",
        transferMin: 0,
        stops: [stop("place_011", "visit", 0)],
        returnTravelMin: 5,
      },
      {
        date: "2026-10-15",
        anchorId: "florence",
        transferMin: 120,
        stops: [stop("place_027", "visit", 30)],
        returnTravelMin: 30,
      },
    ],
    source: "ai",
    warnings: [],
    meta: { attempts: 1, latencyMs: 0, generatedAt: "2026-09-24T12:00:00.000Z" },
  };
}

describe("plan shape", () => {
  it("counts only visits for preference match, never the meals", () => {
    // Visits: Colosseum (no food tag), Campo de' Fiori (food), Giolitti (food), Piazzale
    // Michelangelo (no food tag). The food-tagged lunch at Da Enzo does not count.
    expect(preferenceMatch(handBuilt(), ctx)).toBe(0.5);
  });

  it("reports no preference match, not zero, when the traveler gave no interests", () => {
    expect(preferenceMatch(handBuilt([]), ctx)).toBeNull();
  });

  it("splits travel within days from transfers between bases", () => {
    const shape = planShape(handBuilt(), ctx);
    // Day 1: 10 + 20 + 5 + 15 back = 50; day 2: 0 + 5 = 5; day 3: 30 + 30 = 60.
    expect(shape.travelMinPerDay).toBeCloseTo(115 / 3, 10);
    expect(shape.transferMinPerTrip).toBe(120);
    expect(shape.visitsPerDay).toBeCloseTo(4 / 3, 10);
    expect(shape.paceCap).toBe(5);
    expect(shape.anchors).toBe(2);
  });

  it("calls a real rules-only plan valid and a broken one invalid", () => {
    const good = plan({ interests: ["food"] });
    expect(isFinalValid(good, ctx)).toBe(true);
    expect(isFinalValid(handBuilt(), ctx)).toBe(false);
    const duplicated = structuredClone(good);
    const first = duplicated.days[0]?.stops[0];
    if (first) duplicated.days[1]?.stops.push({ ...first });
    expect(isFinalValid(duplicated, ctx)).toBe(false);
  });
});

describe("must-includes in the first answer", () => {
  const shortlist = { mustInclude: ["place_007", "place_026"] } as unknown as Shortlist;
  const day = (anchorId: string, placeIds: string[]) => ({ anchorId, placeIds, reasons: [] });
  const text = JSON.stringify({
    days: [
      day("rome", ["place_007", "place_001"]),
      day("rome", ["place_005"]),
      day("rome", ["place_004"]),
    ],
    summary: "Rome.",
  });
  const answer = (rawText: string, stopReason = "end_turn"): CallRecord => ({
    turn: "select",
    response: {
      rawText,
      stopReason,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
      model: "m",
    },
  });

  it("counts placeable must-includes in the first answer, skipping failed calls before it", () => {
    const failed: CallRecord = { turn: "select", error: { kind: "overloaded", message: "busy" } };
    expect(firstAnswerMustInclude([failed, answer(text)], shortlist)).toEqual({
      placed: 1,
      placeable: 2,
    });
  });

  it("counts none placed when the first answer was cut off or off-schema", () => {
    expect(firstAnswerMustInclude([answer(text, "max_tokens")], shortlist)?.placed).toBe(0);
    expect(firstAnswerMustInclude([answer('{"days":1}')], shortlist)?.placed).toBe(0);
  });

  it("has no count at all when the model never answered", () => {
    expect(firstAnswerMustInclude([], shortlist)).toBeNull();
  });
});

describe("small math", () => {
  it("takes nearest-rank percentiles of unsorted values", () => {
    expect(percentile([5000, 200, 3000, 1000], 50)).toBe(1000);
    expect(percentile([5000, 200, 3000, 1000], 95)).toBe(5000);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });

  it("returns null, never NaN or zero, for an empty mean or a zero denominator", () => {
    expect(mean([])).toBeNull();
    expect(rate(0, 0)).toBeNull();
    expect(mean([1, 2])).toBe(1.5);
  });
});

describe("summary", () => {
  const measures = [
    measure({
      caseId: "a",
      run: 1,
      latencyMs: 1000,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.002,
      mustInclude: { placed: 1, placeable: 1 },
    }),
    measure({
      caseId: "a",
      run: 2,
      source: "ai_repaired",
      firstPassValid: false,
      repairTried: true,
      latencyMs: 3000,
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.004,
      mustInclude: { placed: 0, placeable: 1 },
      checks: [{ name: "summaryMentions", status: "fail", detail: "no summary" }],
    }),
    measure({
      caseId: "b",
      run: 1,
      source: "deterministic",
      fallbackReason: "timeout",
      firstPassValid: false,
      repairTried: true,
      latencyMs: 5000,
    }),
    measure({
      caseId: "b",
      run: 2,
      source: "deterministic",
      fallbackReason: "rate_limited",
      answered: false,
      firstPassValid: false,
      latencyMs: 200,
      mustInclude: null,
    }),
  ];
  const s = summarize(measures);

  it("rates first-pass validity and repairs over plans the model answered, fallbacks over all plans", () => {
    expect(s.plans).toBe(4);
    expect(s.answeredPlans).toBe(3);
    expect(s.firstPassValidRate).toBeCloseTo(1 / 3, 10);
    expect(s.repairRate).toBeCloseTo(2 / 3, 10);
    expect(s.repairSuccessRate).toBe(0.5);
    expect(s.fallbackRate).toBe(0.5);
    expect(s.fallbackReasons).toEqual({ rate_limited: 1, timeout: 1 });
    expect(s.finalValidRate).toBe(1);
  });

  it("pools must-includes across plans and ignores plans without an answer", () => {
    expect(s.mustIncludeRate).toBe(0.5);
  });

  it("averages tokens and cost only over plans that have them", () => {
    expect(s.avgInputTokens).toBe(200);
    expect(s.avgCostUsd).toBeCloseTo(0.003, 10);
    expect(s.latencyP50Ms).toBe(1000);
    expect(s.latencyP95Ms).toBe(5000);
  });

  it("passes a case only when every run met every expectation", () => {
    const rows = s.cases.map((c) => [c.caseId, c.runs, c.passedRuns, c.failedChecks]);
    expect(rows).toEqual([
      ["a", 2, 1, ["summaryMentions"]],
      ["b", 2, 2, []],
    ]);
    expect(s.casesPassed).toBe(1);
    expect(s.casesPassedWithSkips).toBe(0);
  });

  it("never lets a skipped check pass as met: a pass that rests on one is counted apart", () => {
    const skipped = measure({
      caseId: "baseline-case",
      checks: [{ name: "summaryMentions", status: "skip", detail: "no summary" }],
    });
    const summary = summarize([skipped, measure({ caseId: "checked-case" })]);
    expect(summary.casesPassed).toBe(2);
    expect(summary.casesPassedWithSkips).toBe(1);
    expect(summary.cases[0]?.skippedChecks).toEqual(["summaryMentions"]);
  });

  it("fails a case whose plan is not valid even when every expectation passed", () => {
    const shape = measure().shape as PlanShape;
    const broken = measure({ shape: { ...shape, finalValid: false } });
    const summary = summarize([broken]);
    expect(summary.finalValidRate).toBe(0);
    expect(summary.cases[0]?.failedChecks).toEqual(["finalValid"]);
  });

  it("reports nothing rather than zero for an empty run", () => {
    const empty = summarize([]);
    expect(empty.finalValidRate).toBeNull();
    expect(empty.preferenceMatch).toBeNull();
    expect(empty.casesPassed).toBe(0);
  });
});
