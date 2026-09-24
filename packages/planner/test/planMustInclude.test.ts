import { describe, expect, it } from "vitest";
import { buildDay } from "../src/dayBuilder";
import { type PlannedTrip, unplacedMustIncludes } from "../src/mustInclude";
import { repairMustIncludes } from "../src/mustRepair";
import { planDeterministic } from "../src/plan";
import { scheduleDay } from "../src/schedule";
import { tripDates } from "../src/time";
import { PoolCache } from "../src/tripBuilder";
import type { TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// A must-include place is the traveler's explicit wish. It must be placed whenever it can be,
// and when it cannot, the plan must say why in plain words (MUST_INCLUDE_UNPLACEABLE). A silent
// drop, or a place left out that fit, is the failure these tests prevent.

const ctx = realContext();
const MONDAY = "2026-10-19";
const JANUARY = "2027-01-11";

function trip(startDate: string, anchorIds: string[], placed: string[] = []): PlannedTrip {
  return { dates: tripDates(startDate), anchorIds, placedIds: new Set(placed) };
}

function reason(request: Partial<TripRequest>, planned: PlannedTrip): string | undefined {
  return unplacedMustIncludes(makeRequest(request), ctx, planned)[0]?.detail;
}

describe("plain reasons for a must-include left out", () => {
  it("says an invented id is not in the data rather than naming it", () => {
    expect(reason({ mustInclude: ["place_999"] }, trip(MONDAY, ["rome", "rome", "rome"]))).toBe(
      "A place you asked for is not in the data, so it could not be included.",
    );
  });

  it("says a place both required and excluded was excluded", () => {
    const planned = trip(MONDAY, ["rome", "rome", "rome"]);
    expect(reason({ mustInclude: ["place_005"], exclude: ["place_005"] }, planned)).toBe(
      "Pantheon could not be included. It is also on your excluded list.",
    );
  });

  it("says a lake villa is closed on every day of a January trip", () => {
    const planned = trip(JANUARY, ["milan", "milan", "milan"]);
    expect(reason({ mustInclude: ["place_064"] }, planned)).toMatch(
      /closed on every day of the trip/,
    );
  });

  it("says the base was not one the traveler chose", () => {
    const planned = trip(MONDAY, ["rome", "rome", "rome"]);
    expect(reason({ mustInclude: ["place_026"], anchors: ["rome"] }, planned)).toMatch(
      /Its base, Florence, is not one of the bases you chose\.$/,
    );
  });

  it("names the two-base limit when the planner chose the bases", () => {
    const planned = trip(MONDAY, ["rome", "rome", "florence"]);
    expect(reason({ mustInclude: ["place_067"] }, planned)).toMatch(
      /Its base, Venice, is not in this trip\. A trip uses at most 2 bases\.$/,
    );
  });

  it("says the museum is closed on the only day spent at its base (Borghese on a Monday)", () => {
    const planned = trip(MONDAY, ["rome", "florence", "florence"]);
    expect(reason({ mustInclude: ["place_007"] }, planned)).toMatch(
      /closed on the days this trip spends in Rome\.$/,
    );
  });

  it("says a dawn walk does not fit a relaxed day that starts at 10:00", () => {
    const planned = trip(MONDAY, ["venice", "venice", "venice"]);
    expect(reason({ mustInclude: ["place_075"], pace: "relaxed" }, planned)).toMatch(
      /does not fit its opening hours within a relaxed day in Venice\.$/,
    );
  });

  it("says there was no room when it fits an empty day but the plan is full", () => {
    const planned = trip(MONDAY, ["rome", "rome", "rome"]);
    expect(reason({ mustInclude: ["place_005"] }, planned)).toMatch(/no room for it/);
  });

  it("reports nothing for placed must-includes and one warning per repeated id", () => {
    const planned = trip(MONDAY, ["rome", "rome", "rome"], ["place_005"]);
    const request = makeRequest({ mustInclude: ["place_005", "place_999", "place_999"] });
    const warnings = unplacedMustIncludes(request, ctx, planned);
    expect(warnings.map((w) => [w.code, w.severity, w.placeId])).toEqual([
      ["MUST_INCLUDE_UNPLACEABLE", "warning", "place_999"],
    ]);
  });
});

describe("placing competing must-includes", () => {
  // Two must-include restaurants that can both seat lunch at 12:00 after a morning transfer.
  function contestedLunch(laterDays: Record<string, number>): Record<string, string | undefined> {
    const request = makeRequest({
      startDate: "2026-10-20",
      mustInclude: ["place_029", "place_033"],
    });
    const anchor = ctx.anchorById.get("florence");
    if (!anchor) throw new Error("no florence");
    const day = buildDay({
      date: "2026-10-20",
      anchor,
      transferMin: 130,
      request,
      ctx,
      pool: new PoolCache(request, ctx).strict("florence"),
      used: new Set(),
      obligations: new Set(Object.keys(laterDays)),
      laterDays: new Map(Object.entries(laterDays)),
    });
    const timed = scheduleDay(day.ids, "2026-10-20", anchor, request, ctx, 130);
    return Object.fromEntries(timed.stops.map((stop) => [stop.placeId, stop.role]));
  }

  it("gives a contested lunch to the must-include with no later day, never the flexible one", () => {
    expect(contestedLunch({ place_029: 1, place_033: 0 })).toMatchObject({
      place_033: "lunch",
      place_029: "dinner",
    });
    expect(contestedLunch({ place_029: 0, place_033: 1 })).toMatchObject({
      place_029: "lunch",
      place_033: "dinner",
    });
  });

  it("keeps a must-include's only lunch reachable instead of filling the morning (look-ahead)", () => {
    // Sunday in Florence, relaxed: Il Latini (lunch must start at 12:30, closed Monday) and the
    // dinner-only Rasputin. A long morning visit would leave both needing the one dinner.
    const date = "2028-03-05";
    const request = makeRequest({
      startDate: date,
      pace: "relaxed",
      mustInclude: ["place_039", "place_037"],
    });
    const anchor = ctx.anchorById.get("florence");
    if (!anchor) throw new Error("no florence");
    const day = buildDay({
      date,
      anchor,
      transferMin: 0,
      request,
      ctx,
      pool: new PoolCache(request, ctx).strict("florence"),
      used: new Set(),
      obligations: new Set(["place_037", "place_039"]),
      laterDays: new Map([
        ["place_037", 0],
        ["place_039", 0],
      ]),
    });
    expect(day.ids).toEqual(expect.arrayContaining(["place_037", "place_039"]));
  });

  it("places must-includes from two bases and explains the third base in a trip", () => {
    const itinerary = planDeterministic(
      makeRequest({ mustInclude: ["place_001", "place_026", "place_067"] }),
      ctx,
    );
    const placed = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    const missing = ["place_001", "place_026", "place_067"].filter((id) => !placed.includes(id));
    expect(missing).toHaveLength(1);
    const unplaceable = itinerary.warnings.filter((w) => w.code === "MUST_INCLUDE_UNPLACEABLE");
    expect(unplaceable.map((w) => w.placeId)).toEqual(missing);
    expect(validateItinerary(itinerary, ctx).filter((v) => v.severity === "error")).toEqual([]);
  });
});

describe("repair pass", () => {
  it("inserts a missing must-include into a full day by dropping ordinary stops only", () => {
    const base = planDeterministic(makeRequest({ anchors: ["rome"], pace: "packed" }), ctx);
    const request = makeRequest({ anchors: ["rome"], pace: "packed", mustInclude: ["place_010"] });
    const dayIds = base.days.map((day) => day.stops.map((stop) => stop.placeId));
    const draft = { anchorIds: ["rome", "rome", "rome"], days: dayIds, score: 0 };
    expect(dayIds.flat()).not.toContain("place_010");
    const repaired = repairMustIncludes(draft, request, ctx, tripDates(request.startDate));
    const index = repaired.days.findIndex((ids) => ids.includes("place_010"));
    expect(index).toBeGreaterThanOrEqual(0);
    const kept = (repaired.days[index] ?? []).filter((id) => id !== "place_010");
    const original = dayIds[index] ?? [];
    expect(kept).toEqual(original.filter((id) => kept.includes(id)));
    const anchor = ctx.anchorById.get("rome");
    if (!anchor) throw new Error("no rome");
    const date = tripDates(request.startDate)[index] ?? "";
    const timed = scheduleDay(repaired.days[index] ?? [], date, anchor, request, ctx, 0);
    expect(timed.violations.filter((v) => v.severity === "error")).toEqual([]);
  });

  it("never removes another must-include to make room", () => {
    const request = makeRequest({ anchors: ["rome"], mustInclude: ["place_005", "place_010"] });
    const draft = {
      anchorIds: ["rome", "rome", "rome"],
      days: [["place_005", "place_002", "place_080"], ["place_004"], ["place_016"]],
      score: 0,
    };
    const repaired = repairMustIncludes(draft, request, ctx, tripDates(request.startDate));
    expect(repaired.days.flat()).toEqual(expect.arrayContaining(["place_005", "place_010"]));
  });

  it("leaves the draft alone when every must-include is already placed", () => {
    const request = makeRequest({ mustInclude: ["place_005"] });
    const draft = {
      anchorIds: ["rome", "rome", "rome"],
      days: [["place_005"], ["place_004"], ["place_016"]],
      score: 3,
    };
    expect(repairMustIncludes(draft, request, ctx, tripDates(request.startDate))).toEqual(draft);
  });
});
