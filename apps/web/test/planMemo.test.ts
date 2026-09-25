import { describe, expect, it } from "vitest";
import { PLAN_MEMO_ENTRIES, PlanMemo } from "../lib/planMemo";
import { aiPlan, fixturePlan, makeRequest } from "./fixtures";

// The tab's memory of the AI plans it has had, by their options: the same options in any order
// find the same plan, only AI plans are kept, and nothing done to a plan it hands out changes it.

describe("PlanMemo", () => {
  it("finds a plan by its options, in any order of interests, must-includes and skips", () => {
    const memo = new PlanMemo();
    const request = makeRequest({
      interests: ["food", "art"],
      exclude: ["place_002", "place_001"],
    });
    const plan = aiPlan();

    memo.set(request, plan);

    const reordered = {
      ...request,
      interests: ["art", "food"],
      exclude: ["place_001", "place_002"],
    };
    expect(memo.get(reordered)).toEqual({ ...plan, request: reordered });
    expect(memo.get({ ...request, pace: "packed" })).toBeUndefined();
    expect(memo.get({ ...request, notes: "Quiet mornings" })).toBeUndefined();
  });

  it("hands the plan out with the request as sent now, like the API's cache", () => {
    const memo = new PlanMemo();
    const request = makeRequest({ interests: ["food", "art"], mustInclude: [] });
    const plan = { ...aiPlan(), request };
    memo.set(request, plan);

    const now = { ...request, interests: ["art", "food"] };
    const shown = memo.get(now);

    expect(shown?.request.interests).toEqual(["art", "food"]);
    expect(shown?.request).not.toBe(now); // a copy, like the rest of the plan
    expect(shown?.days).toEqual(plan.days);
    expect(memo.get(request)?.request.interests).toEqual(["food", "art"]);
  });

  it("keeps only AI plans, never a rules-only plan the API fell back to", () => {
    const memo = new PlanMemo();
    const fallback = {
      ...fixturePlan(),
      meta: { ...fixturePlan().meta, fallbackReason: "timeout" as const },
    };

    memo.set(makeRequest(), fallback);
    memo.set(makeRequest({ pace: "packed" }), { ...aiPlan(), source: "ai_repaired" });

    expect(memo.get(makeRequest())).toBeUndefined();
    expect(memo.get(makeRequest({ pace: "packed" }))?.source).toBe("ai_repaired");
  });

  it("hands out copies, so an edit can never change the plan it keeps", () => {
    const memo = new PlanMemo();
    const plan = aiPlan();
    memo.set(makeRequest(), plan);
    plan.days[0]?.stops.pop();

    const first = memo.get(makeRequest());
    first?.days[0]?.stops.splice(0, 1);

    expect(memo.get(makeRequest())).toEqual(aiPlan());
  });

  it(`keeps the ${PLAN_MEMO_ENTRIES} most recently used plans`, () => {
    const memo = new PlanMemo(2);
    const a = makeRequest({ startDate: "2026-10-06" });
    const b = makeRequest({ startDate: "2026-10-07" });
    const c = makeRequest({ startDate: "2026-10-08" });
    memo.set(a, aiPlan());
    memo.set(b, aiPlan());
    memo.get(a);

    memo.set(c, aiPlan());

    expect(memo.size).toBe(2);
    expect(memo.get(a)).toBeDefined();
    expect(memo.get(b)).toBeUndefined();
    expect(PLAN_MEMO_ENTRIES).toBe(20);
  });
});
