import { describe, expect, it } from "vitest";
import {
  alternativesFor,
  moveStop,
  removeStop,
  replaceStop,
  rescheduleDay,
} from "../src/alternatives";
import { isCandidate, sharesLocation } from "../src/constraints";
import { planDeterministic } from "../src/plan";
import type { Itinerary, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// Swap, remove, and reorder run in the browser. Swap must only ever offer places whose rebuilt
// day is valid (failure vector F1 via edits), and the reducer helpers must never mutate the plan
// the UI is showing (undo depends on the old one staying intact).

const ctx = realContext();
const errorsOf = (violations: { severity: string }[]) =>
  violations.filter((v) => v.severity === "error");

function planFor(overrides: Partial<TripRequest> = {}): Itinerary {
  return planDeterministic(makeRequest({ startDate: "2026-10-20", ...overrides }), ctx);
}

describe("alternativesFor", () => {
  const itinerary = planFor({ interests: ["art", "food"] });

  it("only offers swaps whose rebuilt day passes scheduleDay and the validator with the same roles", () => {
    let offered = 0;
    itinerary.days.forEach((day, d) => {
      day.stops.forEach((stop, s) => {
        for (const alt of alternativesFor(itinerary, d, s, ctx)) {
          offered++;
          const rebuilt = rescheduleDay(itinerary, d, replaceStop(day, s, alt.place.id), ctx);
          expect(errorsOf(rebuilt.violations)).toEqual([]);
          expect(errorsOf(validateItinerary(rebuilt.itinerary, ctx))).toEqual([]);
          expect(alt.day.stops.map((x) => x.role)).toEqual(day.stops.map((x) => x.role));
          expect(alt.stop).toEqual(alt.day.stops[s]);
          expect(alt.stop.role).toBe(stop.role);
        }
      });
    });
    expect(offered).toBeGreaterThan(5);
  });

  it("never offers a place already in the trip, sharing its spot, excluded, over budget, or elsewhere", () => {
    const request = makeRequest({
      startDate: "2026-10-20",
      maxPriceLevel: 2,
      exclude: ["place_094"],
    });
    const plan = planDeterministic(request, ctx);
    const used = plan.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    plan.days.forEach((day, d) => {
      day.stops.forEach((stop, s) => {
        for (const alt of alternativesFor(plan, d, s, ctx)) {
          const others = used.filter((id) => id !== stop.placeId);
          expect(others).not.toContain(alt.place.id);
          const twins = others.map((id) => ctx.placesById.get(id)).filter((p) => p !== undefined);
          expect(twins.some((twin) => sharesLocation(twin, alt.place))).toBe(false);
          expect(isCandidate(alt.place, request, day.anchorId, ctx)).toBe(true);
        }
      });
    });
  });

  it("returns the best first, at most `limit`, and the same list every time", () => {
    const day = itinerary.days.findIndex((d) => d.stops.length > 0);
    const all = alternativesFor(itinerary, day, 0, ctx, 50);
    const scores = all.map((alt) => alt.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(alternativesFor(itinerary, day, 0, ctx, 2).length).toBeLessThanOrEqual(2);
    expect(alternativesFor(itinerary, day, 0, ctx).map((a) => a.place.id)).toEqual(
      alternativesFor(itinerary, day, 0, ctx).map((a) => a.place.id),
    );
  });

  it("returns [] for a day or stop that does not exist, or a limit below 1, instead of throwing", () => {
    expect(alternativesFor(itinerary, 9, 0, ctx)).toEqual([]);
    expect(alternativesFor(itinerary, 0, 99, ctx)).toEqual([]);
    expect(alternativesFor(itinerary, -1, 0, ctx)).toEqual([]);
    expect(alternativesFor(itinerary, 0, 0, ctx, 0)).toEqual([]);
    expect(alternativesFor(itinerary, 0, 0, ctx, Number.NaN)).toEqual([]);
  });

  it("ignores an error already on another day but offers nothing for a day that is broken", () => {
    const day2 = itinerary.days[2];
    if (!day2) throw new Error("no day");
    // Put a Monday-closed museum on day 2 by hand (a stale shared link, say).
    const broken = rescheduleDay(
      itinerary,
      2,
      ["place_007", ...day2.stops.map((s) => s.placeId)],
      ctx,
    );
    const tampered: Itinerary = {
      ...broken.itinerary,
      days: broken.itinerary.days.map((d, i) => (i === 2 ? { ...d, date: "2026-10-19" } : d)),
    };
    expect(errorsOf(validateItinerary(tampered, ctx)).length).toBeGreaterThan(0);
    expect(alternativesFor(tampered, 0, 0, ctx).length).toBeGreaterThan(0);
    expect(alternativesFor(tampered, 2, 1, ctx)).toEqual([]);
  });

  it("offers no swap for a must-include stop, because removing it breaks the traveler's request", () => {
    const plan = planFor({ anchors: ["rome"], mustInclude: ["place_005"] });
    const d = plan.days.findIndex((day) => day.stops.some((stop) => stop.placeId === "place_005"));
    const s = plan.days[d]?.stops.findIndex((stop) => stop.placeId === "place_005") ?? -1;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(alternativesFor(plan, d, s, ctx)).toEqual([]);
  });

  it("offers lunch places for a lunch and never a restaurant for a visit", () => {
    itinerary.days.forEach((day, d) => {
      day.stops.forEach((stop, s) => {
        for (const alt of alternativesFor(itinerary, d, s, ctx)) {
          if (stop.role === "visit") expect(alt.place.type).not.toBe("restaurant");
          else expect(alt.place.meals).toContain(stop.role);
        }
      });
    });
  });
});

describe("edit helpers", () => {
  const itinerary = planFor();
  const day = itinerary.days[0];
  if (!day) throw new Error("no day");
  const ids = day.stops.map((stop) => stop.placeId);

  it("removes, moves, and replaces by returning new id lists, never mutating the shown day", () => {
    const before = JSON.stringify(day);
    expect(removeStop(day, 0)).toEqual(ids.slice(1));
    expect(moveStop(day, 0, ids.length - 1)).toEqual([...ids.slice(1), ids[0]]);
    expect(replaceStop(day, 1, "place_099")).toEqual([ids[0], "place_099", ...ids.slice(2)]);
    expect(JSON.stringify(day)).toBe(before);
  });

  it("throws RangeError for a stop index that does not exist, never editing the wrong stop", () => {
    for (const bad of [-1, 1.5, ids.length]) {
      expect(() => removeStop(day, bad)).toThrow(RangeError);
      expect(() => moveStop(day, 0, bad)).toThrow(RangeError);
      expect(() => replaceStop(day, bad, "place_001")).toThrow(RangeError);
    }
  });
});

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

  it("replaces only the edited day's warnings and keeps every other day's", () => {
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
