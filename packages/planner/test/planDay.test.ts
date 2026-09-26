import { describe, expect, it } from "vitest";
import { withReplannedDay } from "../src/alternatives";
import { PACE } from "../src/config";
import { checkDayBase, dayBaseOptions, newTripErrors } from "../src/dayBases";
import { planDeterministic } from "../src/plan";
import { dayMustIncludes, planDay, usedOnOtherDays, withDay } from "../src/planDay";
import { tripDates } from "../src/time";
import { type DaySelection, scheduleTrip } from "../src/trip";
import type { Itinerary, TripRequest } from "../src/types";
import { validationErrors } from "../src/validate";
import { realContext } from "./plannerFixtures";

// Re-planning one day of an existing trip (planDay.ts), the cities a day may move to
// (dayBases.ts), and applying a re-planned day to an itinerary (withReplannedDay).

const ctx = realContext();

function request(overrides: Partial<TripRequest> = {}): TripRequest {
  return {
    startDate: "2026-10-19", // a Monday
    pace: "balanced",
    interests: ["historic"],
    maxPriceLevel: null,
    anchors: ["rome"],
    mustInclude: [],
    exclude: [],
    ...overrides,
  };
}

function selectionOf(itinerary: Itinerary): DaySelection[] {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

/** A planned trip and its days as a selection. */
function trip(overrides: Partial<TripRequest> = {}) {
  const req = request(overrides);
  const itinerary = planDeterministic(req, ctx);
  return { req, itinerary, days: selectionOf(itinerary) };
}

const romeTrip = trip();

describe("planDay", () => {
  it("plans the day at the new base from its places only, never another day's", () => {
    const { req, days } = romeTrip;
    const planned = planDay(req, days, 2, "florence", ctx);

    expect(planned.anchorId).toBe("florence");
    expect(planned.placeIds.length).toBeGreaterThan(2);
    for (const id of planned.placeIds) {
      expect(ctx.anchorIdByPlaceId.get(id)).toBe("florence");
    }
    const others = usedOnOtherDays(days, 2);
    expect(planned.placeIds.filter((id) => others.has(id))).toEqual([]);
  });

  it("gives a new version of a day at its own base without another day's places", () => {
    const { req, days } = romeTrip;
    const planned = planDay(req, days, 1, "rome", ctx);
    const others = usedOnOtherDays(days, 1);

    expect(planned.placeIds.length).toBeGreaterThan(0);
    expect(planned.placeIds.some((id) => others.has(id))).toBe(false);
    const rebuilt = withDay(days, 1, planned);
    expect(rebuilt[0]).toBe(days[0]);
    expect(rebuilt[2]).toBe(days[2]);
  });

  it("is deterministic", () => {
    const { req, days } = romeTrip;
    expect(planDay(req, days, 2, "venice", ctx)).toEqual(planDay(req, days, 2, "venice", ctx));
  });

  it("starts a moved day after the transfer from the day before", () => {
    const { req, days } = romeTrip;
    const planned = planDay(req, days, 2, "florence", ctx);
    const timed = scheduleTrip(req, withDay(days, 2, planned), ctx).days[2];

    expect(timed?.transferMin).toBe(130);
    expect(timed?.stops[0]?.start ?? 0).toBeGreaterThanOrEqual(PACE.balanced.dayStart + 130);
  });

  it("never uses an excluded or avoided place, but keeps a must-include the traveler avoided", () => {
    const { days } = romeTrip;
    const first = planDay(request(), days, 2, "florence", ctx);
    const [a, b] = first.placeIds as [string, string];
    const req = request({ exclude: [a], mustInclude: ["place_026"] });
    const planned = planDay(req, days, 2, "florence", ctx, { avoid: [b, "place_026"] });

    expect(planned.placeIds).not.toContain(a);
    expect(planned.placeIds).not.toContain(b);
    expect(planned.placeIds).toContain("place_026");
  });

  it("puts a must-include of the new base on the day when the trip does not have it", () => {
    // Uffizi Gallery, asked for on a trip the traveler kept in Rome.
    const { req, days, itinerary } = trip({ mustInclude: ["place_026"] });
    expect(selectionOf(itinerary).flatMap((day) => day.placeIds)).not.toContain("place_026");

    expect(dayMustIncludes(req, days, 2, "florence", ctx)).toEqual(["place_026"]);
    expect(planDay(req, days, 2, "florence", ctx).placeIds).toContain("place_026");
  });

  it("leaves a must-include where it is when another day already has it", () => {
    const { req, days } = trip({ mustInclude: ["place_001"] });
    const holder = days.findIndex((day) => day.placeIds.includes("place_001"));
    const other = holder === 0 ? 1 : 0;

    expect(dayMustIncludes(req, days, other, "rome", ctx)).toEqual([]);
    expect(planDay(req, days, other, "rome", ctx).placeIds).not.toContain("place_001");
    expect(dayMustIncludes(req, days, holder, "rome", ctx)).toEqual(["place_001"]);
    expect(planDay(req, days, holder, "rome", ctx).placeIds).toContain("place_001");
  });

  it("does not ask for a must-include at the spot of a place on another day", () => {
    // Trevi Fountain by Night, asked for, while day 1 has the Trevi Fountain by day.
    const req = request({ mustInclude: ["place_077"] });
    const days: DaySelection[] = [
      { anchorId: "rome", placeIds: ["place_018"] },
      { anchorId: "rome", placeIds: [] },
      { anchorId: "rome", placeIds: ["place_001"] },
    ];

    expect(dayMustIncludes(req, days, 1, "rome", ctx)).toEqual([]);
    const planned = planDay(req, days, 1, "rome", ctx).placeIds;
    expect(planned).not.toContain("place_077");
    expect(planned).not.toContain("place_018");
  });

  it("throws on a day out of range or an unknown base", () => {
    const { req, days } = romeTrip;
    expect(() => planDay(req, days, 3, "rome", ctx)).toThrow(RangeError);
    expect(() => planDay(req, days, -1, "rome", ctx)).toThrow(RangeError);
    expect(() => planDay(req, days, 0, "atlantis", ctx)).toThrow(RangeError);
  });
});

describe("dayBaseOptions", () => {
  it("lists every base, the day's own first, with the transfers in and out", () => {
    const { req, days } = romeTrip;
    const options = dayBaseOptions(req, days, 2, ctx);

    expect(options.map((o) => o.anchorId)).toEqual([
      "rome",
      ...ctx.anchors.map((a) => a.id).filter((id) => id !== "rome"),
    ]);
    expect(options[0]).toEqual({
      anchorId: "rome",
      name: "Rome",
      current: true,
      allowed: true,
      transferInMin: 0,
      transferOutMin: 0,
    });
    // The last day of a trip can always move: no later day has to fit after it.
    expect(options.every((o) => o.allowed)).toBe(true);
    expect(options.find((o) => o.anchorId === "florence")?.transferInMin).toBe(130);
  });

  it("refuses a third city, naming the two the other days use", () => {
    const { req, days } = trip({ anchors: ["rome", "florence"], startDate: "2026-10-18" });
    expect(new Set(days.map((d) => d.anchorId))).toEqual(new Set(["rome", "florence"]));
    const venice = checkDayBase(req, days, days.length - 1, "venice", ctx);
    const reason = venice.option.reason ?? "";

    expect(venice.option).toMatchObject({ allowed: false, refusal: "too_many_bases" });
    expect(venice.day).toBeNull();
    expect(reason).toMatch(/^A trip can use at most 2 cities, and the other days use /);
  });

  it("keeps a day that holds a must-include in its city, and says which place", () => {
    const { req, days } = trip({ mustInclude: ["place_001"] });
    const holder = days.findIndex((day) => day.placeIds.includes("place_001"));
    const option = checkDayBase(req, days, holder, "florence", ctx).option;

    expect(option).toMatchObject({ allowed: false, refusal: "holds_must_include" });
    expect(option.reason).toBe(`Day ${holder + 1} has Colosseum, which you asked for.`);
    expect(checkDayBase(req, days, holder, "rome", ctx).option.allowed).toBe(true);
  });

  it("refuses a move that goes back and forth, and says which day to move first", () => {
    const { req, days } = romeTrip;
    const option = checkDayBase(req, days, 1, "florence", ctx).option;

    expect(option).toMatchObject({
      allowed: false,
      refusal: "back_and_forth",
      transferInMin: 130,
      transferOutMin: 130,
    });
    expect(option.reason).toBe(
      "A trip changes city once at most, so it cannot go from Rome to Florence and back. Move day 3 to Florence first.",
    );
    // Once day 3 is in Florence, day 2 can follow it.
    const moved = checkDayBase(req, days, 2, "florence", ctx).day as DaySelection;
    const after = withDay(days, 2, moved);
    expect(checkDayBase(req, after, 1, "florence", ctx).option.allowed).toBe(true);
    // Rome, Rome, Florence: day 1 cannot leave for Florence before day 2 does, and day 3 cannot
    // come back to Rome before day 2 does. The hint names the day in between both times.
    expect(checkDayBase(req, after, 0, "florence", ctx).option.reason).toBe(
      "A trip changes city once at most, so it cannot go from Florence to Rome and back. Move day 2 to Florence first.",
    );
    const follow = checkDayBase(req, after, 1, "florence", ctx).day as DaySelection;
    const twoDays = withDay(after, 1, follow);
    expect(checkDayBase(req, twoDays, 2, "rome", ctx).option.reason).toBe(
      "A trip changes city once at most, so it cannot go from Rome to Florence and back. Move day 2 to Rome first.",
    );
  });

  it("never lets a day go away for one day and come back, whatever the validator says", () => {
    // Milan, Florence, Milan passed the validator on this trip: 2 h 15 min each way for one day.
    const { req, days } = trip({ anchors: ["milan"] });
    for (const base of ctx.anchors.map((anchor) => anchor.id).filter((id) => id !== "milan")) {
      const option = checkDayBase(req, days, 1, base, ctx).option;
      expect(option).toMatchObject({ allowed: false, refusal: "back_and_forth" });
    }
    // With no neighbour free to move first, the reason stops at the rule: day 3 holds a place
    // the traveler asked for, and day 1 cannot move (the next test).
    const { days: rome } = romeTrip;
    const pinned = request({ mustInclude: [rome[2]?.placeIds[0] as string] });
    expect(checkDayBase(pinned, rome, 1, "florence", ctx).option.reason).toBe(
      "A trip changes city once at most, so it cannot go from Rome to Florence and back.",
    );
  });

  it("gives no hint when the next day cannot move either", () => {
    const { req, days } = romeTrip;
    const option = checkDayBase(req, days, 0, "florence", ctx).option;

    expect(option).toMatchObject({ allowed: false, refusal: "new_error" });
    expect(option.reason).toBe(
      "Day 2 would start after 2 h 10 min of travel from Florence, and its plan would not fit.",
    );
  });

  it("refuses a move that leaves the next day's plan unable to fit its earlier start", () => {
    // Bologna, packed, the lowest budget: day 3 moved to Rome is planned after a long transfer,
    // and with day 2 in Rome too it would start at the day's start instead.
    const req = request({
      startDate: "2027-05-13",
      pace: "packed",
      interests: [],
      maxPriceLevel: 1,
      anchors: ["bologna"],
    });
    const days = selectionOf(planDeterministic(req, ctx));
    const day3 = checkDayBase(req, days, 2, "rome", ctx).day as DaySelection;
    const option = checkDayBase(req, withDay(days, 2, day3), 1, "rome", ctx).option;

    expect(option.allowed).toBe(false);
    expect(option.transferOutMin).toBe(0);
    expect(option.reason).toBe("Day 3's plan would not fit its new start time.");
  });

  it("says when nothing at a base fits the day", () => {
    const { req, days } = romeTrip;
    const avoid = ctx.anchorById.get("milan")?.placeIds ?? [];
    const option = checkDayBase(req, days, 2, "milan", ctx, { avoid }).option;

    expect(option).toMatchObject({ allowed: false, refusal: "nothing_fits" });
    expect(option.reason).toBe("Nothing in Milan fits day 3 with your settings.");
  });

  it("does not hold an error the trip already had elsewhere against the re-plan", () => {
    const { req, days } = romeTrip;
    // Day 1 repeats a place of day 2: DUPLICATE_PLACE before any re-plan.
    const broken = withDay(days, 0, {
      anchorId: "rome",
      placeIds: [...(days[0]?.placeIds ?? []), days[1]?.placeIds[0] as string],
    });
    const check = checkDayBase(req, broken, 2, "venice", ctx);

    expect(check.option.allowed).toBe(true);
    expect(newTripErrors(req, broken, 2, check.day as DaySelection, ctx)).toEqual([]);
    // An error on the re-planned day itself always counts.
    const repeat = { anchorId: "rome", placeIds: [days[0]?.placeIds[0] as string] };
    expect(newTripErrors(req, days, 2, repeat, ctx).map((e) => e.code)).toContain(
      "DUPLICATE_PLACE",
    );
    // Even one the day had before: a re-plan that keeps it is not a clean day.
    const kept = withDay(days, 2, {
      anchorId: "rome",
      placeIds: [...(days[2]?.placeIds ?? []), days[0]?.placeIds[0] as string],
    });
    const again = kept[2] as DaySelection;
    expect(newTripErrors(req, kept, 2, again, ctx).map((e) => e.code)).toContain("DUPLICATE_PLACE");
  });

  it("throws on a day out of range or an unknown base", () => {
    const { req, days } = romeTrip;
    expect(() => dayBaseOptions(req, days, 5, ctx)).toThrow(RangeError);
    expect(() => checkDayBase(req, days, 0, "atlantis", ctx)).toThrow(RangeError);
  });
});

describe("withReplannedDay", () => {
  it("applies a moved day and times the trip again, other days' places unchanged", () => {
    const { req, days, itinerary } = romeTrip;
    const moved = checkDayBase(req, days, 2, "florence", ctx).day as DaySelection;
    const timed = scheduleTrip(req, withDay(days, 2, moved), ctx).days[2];
    const withSummary = { ...itinerary, summary: "Three days in Rome." };
    const next = withReplannedDay(withSummary, 2, timed as Itinerary["days"][number], ctx);

    expect(next.days[2]?.anchorId).toBe("florence");
    expect(next.days[2]?.transferMin).toBe(130);
    expect(next.days[2]?.date).toBe(tripDates(req.startDate)[2]);
    expect(selectionOf(next).slice(0, 2)).toEqual(days.slice(0, 2));
    expect(next.summary).toBeUndefined();
    expect(validationErrors(next, ctx)).toEqual([]);
    expect(next.warnings.every((w) => w.severity === "warning")).toBe(true);
  });

  it("keeps the summary and the new day's AI reasons for a new version at the same base", () => {
    const { req, days, itinerary } = romeTrip;
    const planned = planDay(req, days, 1, "rome", ctx);
    const timed = scheduleTrip(req, withDay(days, 1, planned), ctx)
      .days[1] as Itinerary["days"][number];
    const stops = timed.stops.map((stop) => ({
      ...stop,
      reason: "A calm stop that suits the trip.",
      reasonSource: "ai" as const,
    }));
    const next = withReplannedDay({ ...itinerary, summary: "Rome." }, 1, { ...timed, stops }, ctx);

    expect(next.summary).toBe("Rome.");
    expect(next.days[1]?.stops.map((s) => s.reasonSource)).toEqual(stops.map(() => "ai"));
    expect(next.days[0]?.stops).toEqual(itinerary.days[0]?.stops);
  });

  it("moves the next day's start when the day before it changes city", () => {
    const { req, days, itinerary } = romeTrip;
    const moved = checkDayBase(req, days, 2, "florence", ctx).day as DaySelection;
    const once = withReplannedDay(
      itinerary,
      2,
      scheduleTrip(req, withDay(days, 2, moved), ctx).days[2] as Itinerary["days"][number],
      ctx,
    );
    const follow = checkDayBase(req, selectionOf(once), 1, "florence", ctx).day as DaySelection;
    const twice = withReplannedDay(
      once,
      1,
      scheduleTrip(req, withDay(selectionOf(once), 1, follow), ctx)
        .days[1] as Itinerary["days"][number],
      ctx,
    );

    expect(twice.days.map((d) => d.transferMin)).toEqual([0, 130, 0]);
    expect(validationErrors(twice, ctx)).toEqual([]);
  });

  it("throws on a day out of range", () => {
    const { itinerary } = romeTrip;
    const day = itinerary.days[0] as Itinerary["days"][number];
    expect(() => withReplannedDay(itinerary, 3, day, ctx)).toThrow(RangeError);
  });
});
