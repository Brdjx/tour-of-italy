import { describe, expect, it } from "vitest";
import { repairMustIncludes } from "../src/mustRepair";
import { planDeterministic } from "../src/plan";
import { scheduleDay } from "../src/schedule";
import { tripDates } from "../src/time";
import type { TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// A must-include place is the traveler's explicit wish. It must be placed whenever it can be,
// and when it cannot, the plan must say why in plain words (MUST_INCLUDE_UNPLACEABLE). A silent
// drop, a place left out that fit, or a reason that blames the wrong thing is the failure these
// tests prevent. The reasons come from the validator, the one source of warnings.

const ctx = realContext();
const JANUARY = "2027-01-11";

/** The warning planDeterministic gives for a must-include it left out, or undefined. */
function reasonFor(request: Partial<TripRequest>, placeId: string): string | undefined {
  const itinerary = planDeterministic(makeRequest(request), ctx);
  const warning = itinerary.warnings.find(
    (w) => w.code === "MUST_INCLUDE_UNPLACEABLE" && w.placeId === placeId,
  );
  return warning?.detail;
}

describe("plain reasons for a must-include left out (the validator's words, one source)", () => {
  it("never names an invented id: it says the place is not in the data", () => {
    expect(reasonFor({ mustInclude: ["place_999"] }, "place_999")).toBe(
      "A place you asked for could not be included: it is not in our data.",
    );
  });

  it("never plans a place both required and excluded, and says it was excluded", () => {
    expect(reasonFor({ mustInclude: ["place_005"], exclude: ["place_005"] }, "place_005")).toBe(
      "Pantheon could not be included: you also asked to leave it out.",
    );
  });

  it("never blames the bases for a lake villa closed on every day of a January trip", () => {
    expect(reasonFor({ startDate: JANUARY, mustInclude: ["place_064"] }, "place_064")).toBe(
      "Villa del Balbianello, Lake Como could not be included: it is closed on every day of this trip (Open April-October only).",
    );
  });

  it.each<[string, Partial<TripRequest>]>([
    ["the planner chose the bases", {}],
    ["the traveler chose another base", { anchors: ["rome"] }],
    ["the traveler chose its own base", { anchors: ["bologna"] }],
  ])("never blames the bases for an October-only festival in June when %s", (_label, request) => {
    const detail = reasonFor(
      { startDate: "2026-06-10", mustInclude: ["place_090"], ...request },
      "place_090",
    );
    expect(detail).toBe(
      "Isola della Scala Risotto Festival could not be included: it is closed on every day of this trip (October only).",
    );
  });

  it("never blames the bases for the Brera market on the wrong weekend", () => {
    const detail = reasonFor({ startDate: "2027-03-15", mustInclude: ["place_059"] }, "place_059");
    expect(detail).toMatch(/closed on every day of this trip \(Third weekend of each month only/);
  });

  it("says the base was not one the traveler chose", () => {
    const detail = reasonFor({ mustInclude: ["place_026"], anchors: ["rome"] }, "place_026");
    expect(detail).toBe(
      "Uffizi Gallery could not be included: its base, Florence, is not one of the bases you chose.",
    );
  });

  it("names the two-base limit when must-includes span three bases", () => {
    const itinerary = planDeterministic(
      makeRequest({ mustInclude: ["place_001", "place_026", "place_067"] }),
      ctx,
    );
    const placed = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    const missing = ["place_001", "place_026", "place_067"].filter((id) => !placed.includes(id));
    expect(missing).toHaveLength(1);
    const warning = itinerary.warnings.find((w) => w.placeId === missing[0]);
    expect(warning?.detail).toMatch(/is not in this trip, which already has 2 bases\.$/);
    expect(validateItinerary(itinerary, ctx).filter((v) => v.severity === "error")).toEqual([]);
  });

  it("says a dawn walk does not fit a relaxed day that starts at 10:00", () => {
    const detail = reasonFor({ mustInclude: ["place_023"], pace: "relaxed" }, "place_023");
    expect(detail).toMatch(/its opening hours do not fit a relaxed day on any day of this trip\.$/);
  });

  it("never leaves the early walk in Cannaregio out of a packed Venice trip", () => {
    const itinerary = planDeterministic(
      makeRequest({ mustInclude: ["place_075"], anchors: ["venice"], pace: "packed" }),
      ctx,
    );
    const stop = itinerary.days.flatMap((day) => day.stops).find((s) => s.placeId === "place_075");
    expect(stop?.end).toBeLessThanOrEqual(11 * 60);
  });

  it("reports nothing for placed must-includes and one warning per repeated id", () => {
    const itinerary = planDeterministic(
      makeRequest({ mustInclude: ["place_005", "place_999", "place_999"] }),
      ctx,
    );
    const unplaceable = itinerary.warnings.filter((w) => w.code.startsWith("MUST_INCLUDE"));
    expect(unplaceable.map((w) => [w.code, w.severity, w.placeId])).toEqual([
      ["MUST_INCLUDE_UNPLACEABLE", "warning", "place_999"],
    ]);
  });
});

describe("placing competing must-includes", () => {
  it("never leaves out a requested lunch place or a requested dinner-only place (Florence, Sunday)", () => {
    // Il Latini (lunch starts by 12:30, closed Monday) and the dinner-only Rasputin, asked for
    // together on a relaxed trip: both must be seated, each in a meal it can take.
    const request = makeRequest({
      startDate: "2028-03-05",
      pace: "relaxed",
      mustInclude: ["place_039", "place_037"],
    });
    const stops = planDeterministic(request, ctx).days.flatMap((day) => day.stops);
    const role = (id: string) => stops.find((stop) => stop.placeId === id)?.role;
    expect(role("place_039")).toBe("lunch");
    expect(role("place_037")).toBe("dinner");
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
    const dayIds = base.days.map((day) => day.stops.map((stop) => stop.placeId));
    // A Rome sight the full packed plan left out (Castel Sant'Angelo or the Palatine Hill).
    const wanted = ["place_017", "place_016", "place_012"].find(
      (id) => !dayIds.flat().includes(id),
    );
    if (!wanted) throw new Error("the packed plan used every candidate");
    const request = makeRequest({ anchors: ["rome"], pace: "packed", mustInclude: [wanted] });
    const draft = { anchorIds: ["rome", "rome", "rome"], days: dayIds, score: 0 };
    const repaired = repairMustIncludes(draft, request, ctx, tripDates(request.startDate));
    const index = repaired.days.findIndex((ids) => ids.includes(wanted));
    expect(index).toBeGreaterThanOrEqual(0);
    const kept = (repaired.days[index] ?? []).filter((id) => id !== wanted);
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

  it("never empties a Venice day before 19:00 to fit a requested cicchetti crawl", () => {
    // Property counterexample: tried from the start of the day, the crawl went first (a dinner at
    // 19:00) and every morning stop was removed to make room; appended, it removes nothing.
    const request = makeRequest({
      startDate: "2027-02-16",
      anchors: ["venice"],
      mustInclude: ["place_068"],
    });
    const day = ["place_074", "place_067", "place_076", "place_091"];
    const draft = { anchorIds: ["venice", "venice", "venice"], days: [day, [], []], score: 0 };
    const repaired = repairMustIncludes(draft, request, ctx, tripDates(request.startDate));
    expect(repaired.days[0]).toEqual([...day, "place_068"]);
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
