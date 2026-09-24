import { describe, expect, it } from "vitest";
import { alternativesFor, removeStop, rescheduleDay } from "../src/alternatives";
import { planDeterministic } from "../src/plan";
import { travelMinutes } from "../src/travel";
import type { Itinerary, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// rescheduleDay retimes a day after a remove, a reorder, or a swap in the browser. It must never
// mutate the plan on screen (undo), never throw on a tampered plan, and always leave the plan and
// its warnings exactly as the server's validator would see them (F10).

const ctx = realContext();
const errorsOf = (violations: { severity: string }[]) =>
  violations.filter((v) => v.severity === "error");

function planFor(overrides: Partial<TripRequest> = {}): Itinerary {
  return planDeterministic(makeRequest({ startDate: "2026-10-20", ...overrides }), ctx);
}

describe("rescheduleDay", () => {
  const itinerary = planFor();

  it("rebuilds one day and leaves the other days as the very same objects (undo stays cheap)", () => {
    const day = itinerary.days[1];
    if (!day) throw new Error("no day");
    const result = rescheduleDay(itinerary, 1, removeStop(day, 0), ctx);
    expect(result.itinerary.days[0]).toBe(itinerary.days[0]);
    expect(result.itinerary.days[2]).toBe(itinerary.days[2]);
    expect(result.itinerary.days[1]?.stops).toHaveLength(day.stops.length - 1);
    expect(itinerary.days[1]).toBe(day);
  });

  it("reports an edit that breaks the day in `violations` and never in the traveler's warnings", () => {
    const day = itinerary.days[0];
    if (!day) throw new Error("no day");
    const broken = rescheduleDay(
      itinerary,
      0,
      [...day.stops.map((s) => s.placeId), "place_023"],
      ctx,
    );
    expect(errorsOf(broken.violations).length).toBeGreaterThan(0);
    expect(broken.itinerary.warnings.every((w) => w.severity === "warning")).toBe(true);
  });

  it("keeps an AI reason for a stop that keeps its place and role, and rewrites rule reasons", () => {
    const day = itinerary.days[0];
    const first = day?.stops[0];
    if (!day || !first) throw new Error("no stop");
    const withAi: Itinerary = {
      ...itinerary,
      days: itinerary.days.map((d, i) =>
        i === 0
          ? {
              ...d,
              stops: d.stops.map((s, j) =>
                j === 0 ? { ...s, reason: "Chosen by AI.", reasonSource: "ai" as const } : s,
              ),
            }
          : d,
      ),
    };
    const ids = day.stops.map((s) => s.placeId);
    const result = rescheduleDay(withAi, 0, ids, ctx);
    expect(result.itinerary.days[0]?.stops[0]).toMatchObject({
      reason: "Chosen by AI.",
      reasonSource: "ai",
    });
    expect(result.itinerary.days[0]?.stops.slice(1).every((s) => s.reasonSource === "rule")).toBe(
      true,
    );
  });

  it("never changes another day's warnings when one day is edited", () => {
    const withWarnings = planFor({ mustInclude: ["place_021"], anchors: ["rome"] });
    const warnedDay = withWarnings.warnings.find((w) => w.code === "HOURS_UNKNOWN")?.day ?? 0;
    const other = warnedDay === 0 ? 1 : 0;
    const day = withWarnings.days[other];
    if (!day) throw new Error("no day");
    const result = rescheduleDay(
      withWarnings,
      other,
      day.stops.map((s) => s.placeId),
      ctx,
    );
    const kept = (w: { day?: number }) => w.day === warnedDay;
    expect(result.itinerary.warnings.filter(kept)).toEqual(withWarnings.warnings.filter(kept));
  });

  it("takes a removed must-include off the request, so the browser and the server agree", () => {
    // The review's repro: removing the Colosseum left the edited plan clean in the browser while
    // the server's validator called it MUST_INCLUDE_MISSING, and a shared link of it failed.
    const plan = planFor({ startDate: "2027-05-10", mustInclude: ["place_001"] });
    const d = plan.days.findIndex((day) => day.stops.some((stop) => stop.placeId === "place_001"));
    const day = plan.days[d];
    const s = day?.stops.findIndex((stop) => stop.placeId === "place_001") ?? -1;
    if (!day || s < 0) throw new Error("the Colosseum is not in the plan");
    const edited = rescheduleDay(plan, d, removeStop(day, s), ctx);
    expect(edited.itinerary.request.mustInclude).toEqual([]);
    expect(plan.request.mustInclude).toEqual(["place_001"]); // the shown plan is untouched
    expect(errorsOf(validateItinerary(edited.itinerary, ctx))).toEqual([]);
    const moved = rescheduleDay(plan, d, day.stops.map((stop) => stop.placeId).reverse(), ctx);
    expect(moved.itinerary.request.mustInclude).toEqual(["place_001"]); // a reorder keeps it
  });

  it("states the trip back to the base on the edited day, as a new plan does", () => {
    const day = itinerary.days[0];
    if (!day) throw new Error("no day");
    const edited = rescheduleDay(itinerary, 0, removeStop(day, day.stops.length - 1), ctx);
    const rebuilt = edited.itinerary.days[0];
    const last = ctx.placesById.get(rebuilt?.stops.at(-1)?.placeId ?? "");
    const base = ctx.anchorById.get(rebuilt?.anchorId ?? "");
    if (!last || !base) throw new Error("no last stop");
    expect(rebuilt?.returnTravelMin).toBe(travelMinutes(last, base.centroid));
  });

  it("never throws on a tampered date or transfer: it reports the validator's errors instead", () => {
    const day = itinerary.days[1];
    if (!day) throw new Error("no day");
    const badDate = {
      ...itinerary,
      days: itinerary.days.map((d, i) => (i === 1 ? { ...d, date: "2027-02-30" } : d)),
    };
    const badTransfer = {
      ...itinerary,
      days: itinerary.days.map((d, i) => (i === 1 ? { ...d, transferMin: -100 } : d)),
    };
    const nanTransfer = {
      ...itinerary,
      days: itinerary.days.map((d, i) => (i === 1 ? { ...d, transferMin: Number.NaN } : d)),
    };
    const ids = day.stops.map((stop) => stop.placeId);
    const expected = {
      badDate: "WRONG_DATE",
      badTransfer: "WRONG_TRAVEL",
      nanTransfer: "WRONG_TRAVEL",
    };
    for (const [name, plan] of Object.entries({ badDate, badTransfer, nanTransfer })) {
      expect(alternativesFor(plan, 1, 0, ctx), name).toEqual([]);
      const result = rescheduleDay(plan, 1, ids, ctx);
      const code = expected[name as keyof typeof expected];
      expect(
        result.violations.map((v) => v.code),
        name,
      ).toContain(code);
      expect(result.itinerary.days[1], name).toBe(plan.days[1]);
    }
  });

  it("reports UNKNOWN_ANCHOR for a tampered base instead of throwing", () => {
    const tampered: Itinerary = {
      ...itinerary,
      days: itinerary.days.map((d, i) => (i === 0 ? { ...d, anchorId: "atlantis" } : d)),
    };
    const result = rescheduleDay(tampered, 0, ["place_001"], ctx);
    expect(result.violations.map((v) => v.code)).toEqual(["UNKNOWN_ANCHOR"]);
    expect(() => rescheduleDay(itinerary, 7, [], ctx)).toThrow(RangeError);
  });
});
