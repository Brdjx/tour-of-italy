import type { Itinerary } from "@italy/planner";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECT_PLAN_ATTR, expectPlanScript } from "../lib/expectPlanScript";
import { initialItineraryState, itineraryReducer } from "../lib/itineraryReducer";
import { hasStoredPlan, LAST_PLAN_KEY } from "../lib/lastPlan";
import { ctx, fixturePlan, must } from "./fixtures";

// How a plan reaches the screen when it does not wait for the form: a plan that arrived before
// the places is checked once they load (F1 still holds), and a shared link or saved plan stops
// the static page from painting the form it is about to replace.

/** A plan whose second stop overlaps the first: the validator must flag it. */
function overlapping(): Itinerary {
  const plan = fixturePlan();
  const day = must(plan.days[0], "day 0");
  const [first, second, ...rest] = day.stops;
  const start = must(first, "first stop").start + 5;
  const overlap = { ...must(second, "second stop"), start, end: start + 60 };
  return {
    ...plan,
    days: [{ ...day, stops: [must(first), overlap, ...rest] }, ...plan.days.slice(1)],
  };
}

describe("a plan that arrived before the places", () => {
  it("is marked unchecked, then flagged by the browser's validator once the places load", () => {
    const early = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: overlapping(), origin: "api" },
      null,
    );
    expect(early.checked).toBe(false);
    expect(early.errors).toEqual([]);
    expect(itineraryReducer(early, { type: "check" }, null)).toBe(early);
    const checked = itineraryReducer(early, { type: "check" }, ctx);
    expect(checked.checked).toBe(true);
    expect(checked.errors.length).toBeGreaterThan(0);
    // Nothing new to announce: "Your plan is ready" was said when it arrived.
    expect(checked.message).toBeNull();
    expect(checked.planId).toBe(early.planId);
  });

  it("is never checked twice, so a later edit's result is not overwritten", () => {
    const planned = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: fixturePlan(), origin: "api" },
      ctx,
    );
    expect(planned.checked).toBe(true);
    expect(itineraryReducer(planned, { type: "check" }, ctx)).toBe(planned);
    expect(itineraryReducer(initialItineraryState(), { type: "check" }, ctx).checked).toBe(false);
  });
});

describe("the head script that holds back the form", () => {
  const html = document.documentElement;
  const run = (search: string, stored: string | null, storage: "ok" | "blocked" = "ok") => {
    window.history.replaceState(null, "", `/${search}`);
    window.localStorage.clear();
    if (stored !== null) window.localStorage.setItem(LAST_PLAN_KEY, stored);
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    if (storage === "blocked") {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: () => {
          throw new Error("SecurityError");
        },
      });
    }
    try {
      new Function(expectPlanScript())();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
    return html.hasAttribute(EXPECT_PLAN_ATTR);
  };

  afterEach(() => {
    html.removeAttribute(EXPECT_PLAN_ATTR);
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  });

  it("marks the page for a shared link and for a saved plan, and not otherwise", () => {
    expect(run("?p=abc", null)).toBe(true);
    html.removeAttribute(EXPECT_PLAN_ATTR);
    expect(run("", "{}")).toBe(true);
    html.removeAttribute(EXPECT_PLAN_ATTR);
    expect(run("?mode=deterministic", null)).toBe(false);
  });

  it("never throws when storage is blocked, and still honours a shared link", () => {
    expect(run("", null, "blocked")).toBe(false);
    expect(run("?p=abc", null, "blocked")).toBe(true);
  });

  it("reads the same key the app saves plans under", () => {
    expect(expectPlanScript()).toContain(JSON.stringify(LAST_PLAN_KEY));
    window.localStorage.setItem(LAST_PLAN_KEY, "x");
    expect(hasStoredPlan(window.localStorage)).toBe(true);
    expect(hasStoredPlan(null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(hasStoredPlan(throwing)).toBe(false);
  });
});
