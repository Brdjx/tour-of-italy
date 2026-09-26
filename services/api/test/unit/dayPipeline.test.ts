import {
  checkDayBase,
  type DaySelection,
  newTripErrors,
  planDay,
  planRoute,
  routeStartDays,
  sharesLocation,
  usedOnOtherDays,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type { LlmDayAnswer } from "../../src/llm/client";
import type { DayInput } from "../../src/plan/dayInput";
import { buildDayShortlist } from "../../src/plan/dayShortlist";
import { materializeDay, tidyDay } from "../../src/plan/dayTidy";
import { repairNotes } from "../../src/plan/repairNotes";
import { dayInput, plannedTrip } from "../helpers/day";

// The one-day shortlist (what the model may choose from), the tidy step on a day answer (what
// code removes or reorders before the check), and the check itself (materializeDay).

const { ctx } = shippedData();
const rome = plannedTrip();
/** Day 3 is a Monday, when the Uffizi (place_026) is closed. */
const romeFromSaturday = plannedTrip({ startDate: "2026-10-17" });

/** The rules' day for the input's day and city, which the pipeline falls back to. */
const witnessOf = (input: DayInput): DaySelection =>
  planDay(input.request, input.days, input.day, input.anchorId, ctx, { avoid: input.avoid });

const answer = (placeIds: string[]): LlmDayAnswer => ({
  placeIds,
  reasons: placeIds.map((placeId) => ({ placeId, reason: "A good fit for this trip." })),
});

describe("buildDayShortlist", () => {
  it("offers places of the new base only, none used on another day", () => {
    const input = dayInput(rome, 1, "rome");
    const shortlist = buildDayShortlist(input, ctx);
    const used = usedOnOtherDays(input.days, 1);

    expect(shortlist.anchorIds).toEqual(new Set(["rome"]));
    expect(shortlist.dates).toEqual(rome.days.map((d) => d.date));
    expect([...shortlist.placeIds].filter((id) => used.has(id))).toEqual([]);
    for (const id of shortlist.placeIds) expect(ctx.anchorIdByPlaceId.get(id)).toBe("rome");
    // Each candidate carries its status on every trip date, as the tidy step reads it.
    for (const c of shortlist.options[0]?.candidates ?? []) expect(c.statuses).toHaveLength(3);
  });

  it("never offers a place at the same spot as one on another day", () => {
    // Day 1 has the Trevi Fountain by day; by night is the same spot.
    const input = dayInput(rome, 1, "rome");
    input.days[0] = { anchorId: "rome", placeIds: ["place_018"] };
    const ids = buildDayShortlist(input, ctx).placeIds;

    expect(ids.has("place_077")).toBe(false);
    expect(ids.has("place_018")).toBe(false);
  });

  it("never offers an excluded, avoided, or closed place", () => {
    const trip = plannedTrip({ startDate: "2026-10-17", exclude: ["place_032"] });
    const input = dayInput(trip, 2, "florence", ["place_027"]);
    const ids = buildDayShortlist(input, ctx).placeIds;

    expect(ids.has("place_032")).toBe(false); // excluded
    expect(ids.has("place_027")).toBe(false); // avoided
    expect(ids.has("place_026")).toBe(false); // the Uffizi, closed on Mondays
    expect(ids.size).toBeGreaterThan(5);
  });

  it("offers the day's must-includes, and lists the ones it cannot hold", () => {
    const open = dayInput(plannedTrip({ mustInclude: ["place_026"] }), 2, "florence");
    const closed = dayInput(
      plannedTrip({ mustInclude: ["place_026"], startDate: "2026-10-17" }),
      2,
      "florence",
    );

    const one = buildDayShortlist(open, ctx);
    expect(one.mustInclude).toEqual(["place_026"]);
    const row = one.options[0]?.candidates.find((c) => c.place.id === "place_026");
    expect(row?.mustInclude).toBe(true);
    expect(buildDayShortlist(closed, ctx)).toMatchObject({
      mustInclude: [],
      unplaceable: ["place_026"],
    });
  });

  it("keeps a must-include the traveler also asked to avoid", () => {
    const trip = plannedTrip({ mustInclude: ["place_026"] });
    const shortlist = buildDayShortlist(dayInput(trip, 2, "florence", ["place_026"]), ctx);

    expect(shortlist.placeIds.has("place_026")).toBe(true);
  });

  it("has no option when nothing is left at the base", () => {
    const every = [...(ctx.anchorById.get("milan")?.placeIds ?? [])];
    const shortlist = buildDayShortlist(dayInput(rome, 2, "milan", every), ctx);

    expect(shortlist.options).toEqual([]);
    expect(shortlist.placeIds.size).toBe(0);
  });

  it("throws on a base or day that does not exist", () => {
    expect(() => buildDayShortlist(dayInput(rome, 2, "atlantis"), ctx)).toThrow(RangeError);
    expect(() => buildDayShortlist(dayInput(rome, 7, "rome"), ctx)).toThrow(RangeError);
  });
});

describe("tidyDay", () => {
  const input = dayInput(romeFromSaturday, 2, "florence");
  const shortlist = buildDayShortlist(input, ctx);
  const offered = shortlist.options[0]?.candidates.map((c) => c.place.id) ?? [];
  const otherDay = romeFromSaturday.days[0]?.stops[0]?.placeId as string;

  it("drops a place another day has, and changes no other day", () => {
    const tidied = tidyDay(answer([offered[0] as string, otherDay]), input, shortlist, ctx);

    expect(tidied.ids).toEqual([offered[0]]);
    expect(tidied.changes).toEqual([{ rule: "duplicate", day: 2, placeId: otherDay }]);
    tidied.trip.selection.days.forEach((day, index) => {
      if (index !== 2) expect(day.placeIds).toEqual(input.days[index]?.placeIds);
    });
    const notes = repairNotes(tidied.trip, input.request, shortlist, ctx);
    expect(notes.removed).toEqual([
      `day 3, ${otherDay}: already on day 1; each id may appear once in the trip`,
    ]);
  });

  it("drops a repeat of a later day's place from this day, never from the later day", () => {
    // tidySelection alone keeps the first copy in the trip, which here is this day's.
    const first = dayInput(
      rome,
      0,
      "rome",
      rome.days[0]?.stops.map((s) => s.placeId),
    );
    const list = buildDayShortlist(first, ctx);
    const own = list.options[0]?.candidates.map((c) => c.place.id) ?? [];
    const later = rome.days[2]?.stops[0]?.placeId as string;
    const tidied = tidyDay(answer([own[0] as string, later]), first, list, ctx);

    expect(tidied.ids).toEqual([own[0]]);
    expect(tidied.changes).toEqual([{ rule: "duplicate", day: 0, placeId: later }]);
    expect(tidied.trip.selection.days[2]?.placeIds).toEqual(first.days[2]?.placeIds);
  });

  it("records a place moved to a later day of the route, still empty, as the drop it is", () => {
    // Florence for all three days: days 2 and 3 wait their turn, empty, while day 1 plans.
    const waiting = {
      ...dayInput(rome, 0, "florence"),
      days: [0, 1, 2].map(() => ({ anchorId: "florence", placeIds: [] })),
      route: ["florence", "florence", "florence"],
    };
    const list = buildDayShortlist(waiting, ctx);
    const visits = (list.options[0]?.candidates ?? [])
      .filter((c) => !c.meal)
      .map((c) => c.place.id)
      .slice(0, 9);
    const tidied = tidyDay(answer(visits), waiting, list, ctx);

    expect(tidied.changes.some((change) => change.rule === "moved_day")).toBe(false);
    const dropped = tidied.changes.filter((change) => change.placeId !== undefined);
    expect(dropped.length).toBeGreaterThan(0);
    for (const change of dropped) {
      expect(change).not.toHaveProperty("toDay");
      expect(tidied.ids).not.toContain(change.placeId);
    }
    tidied.trip.selection.days.forEach((day, index) => {
      if (index !== 0) expect(day.placeIds).toEqual([]);
    });
  });

  it("drops a place at the same spot as one on another day", () => {
    const trevi = dayInput(rome, 1, "rome");
    trevi.days[0] = { anchorId: "rome", placeIds: ["place_018"] };
    const list = buildDayShortlist(trevi, ctx);
    const tidied = tidyDay(answer(["place_077"]), trevi, list, ctx);

    expect(tidied.ids).toEqual([]);
    expect(tidied.changes).toEqual([{ rule: "same_spot", day: 1, placeId: "place_077" }]);
    const place = ctx.placesById.get("place_077");
    const twin = ctx.placesById.get("place_018");
    expect(place && twin && sharesLocation(place, twin)).toBe(true);
  });

  it("drops a place closed on the day's date, and reorders what the hours cannot time", () => {
    const [a, b, c] = offered as [string, string, string];
    const tidied = tidyDay(answer(["place_026", c, b, a]), input, shortlist, ctx);

    expect(tidied.ids).not.toContain("place_026");
    expect(tidied.changes[0]).toEqual({ rule: "closed", day: 2, placeId: "place_026" });
  });

  it("keeps an id it was not offered, for the check to report", () => {
    const tidied = tidyDay(answer(["place_999", offered[0] as string]), input, shortlist, ctx);

    expect(tidied.ids).toEqual(["place_999", offered[0]]);
    expect(tidied.changes).toEqual([]);
  });
});

describe("materializeDay", () => {
  const input = dayInput(rome, 2, "florence");
  const shortlist = buildDayShortlist(input, ctx);
  const offered = shortlist.options[0]?.candidates.map((c) => c.place.id) ?? [];

  it("times a clean day in its trip, after the transfer, with the AI reasons that pass", () => {
    const first = offered.find((id) => !ctx.placesById.get(id)?.mealCapable) as string;
    const made = materializeDay(
      { ids: [first], reasons: answer([first]).reasons },
      input,
      shortlist,
      ctx,
      witnessOf(input),
    );

    expect(made.errors).toEqual([]);
    expect(made.dayPlan.anchorId).toBe("florence");
    expect(made.dayPlan.transferMin).toBe(130);
    expect(made.dayPlan.stops[0]?.reasonSource).toBe("ai");
    expect(made.reasonStats).toMatchObject({ kept: 1, replaced: 0 });
  });

  it("reports an id the day's shortlist did not offer, and one that is not a place", () => {
    const venice = ctx.anchorById.get("venice")?.placeIds[0] as string;
    const made = materializeDay(
      { ids: [venice, "place_999"], reasons: [] },
      input,
      shortlist,
      ctx,
      witnessOf(input),
    );
    const unknown = made.errors.filter((e) => e.code === "UNKNOWN_PLACE");

    expect(unknown.map((e) => e.detail)).toContain("This place is not in the candidate list.");
    expect(unknown.map((e) => e.detail)).toContain("This id is not a place in the data.");
    expect(made.errors.every((e) => e.day === 2)).toBe(true);
  });

  it("reports a must-include the day left out", () => {
    const trip = plannedTrip({ mustInclude: ["place_026"] });
    const withMust = dayInput(trip, 2, "florence");
    const list = buildDayShortlist(withMust, ctx);
    const other = list.options[0]?.candidates.find((c) => c.place.id !== "place_026");
    const made = materializeDay(
      { ids: [other?.place.id as string], reasons: [] },
      withMust,
      list,
      ctx,
      witnessOf(withMust),
    );

    expect(made.errors.map((e) => e.code)).toContain("MUST_INCLUDE_MISSING");
  });

  it("reports a must-include the rules' day of a route holds, though the trip already missed it", () => {
    // Rome for three days with Da Enzo al 29 on day 3, routed Rome, Florence, Rome: day 2 moves
    // and day 3 is planned again after its new travel. Day 3 is sent empty, so the restaurant is
    // already missing from the trip sent, and the validator finds it room on day 1, which the
    // route keeps: without the rules' day to compare with, a day 3 without it adds no new error.
    const trip = plannedTrip({
      mustInclude: ["place_003"],
      anchors: ["rome"],
      interests: ["historic"],
    });
    const days = trip.days.map((d) => ({
      anchorId: d.anchorId,
      placeIds: d.stops.map((s) => s.placeId),
    }));
    expect(days[2]?.placeIds).toContain("place_003");
    const route = ["rome", "florence", "rome"];
    const plan = planRoute(trip.request, days, route, ctx);
    expect(plan.replan).toEqual([1, 2]);
    const working = routeStartDays(days, plan);
    working[1] = checkDayBase(trip.request, working, 1, "florence", ctx).day as DaySelection;
    const input: DayInput = {
      request: trip.request,
      days: working,
      day: 2,
      anchorId: "rome",
      avoid: [],
      route,
    };
    const witness = witnessOf(input);
    expect(witness.placeIds).toContain("place_003");
    const without = witness.placeIds.filter((id) => id !== "place_003");
    const day = { anchorId: "rome", placeIds: without };
    expect(newTripErrors(trip.request, working, 2, day, ctx)).toEqual([]);

    const made = materializeDay(
      { ids: without, reasons: [] },
      input,
      buildDayShortlist(input, ctx),
      ctx,
      witness,
    );

    expect(made.errors).toContainEqual(
      expect.objectContaining({ code: "MUST_INCLUDE_MISSING", day: 2, placeId: "place_003" }),
    );
  });

  it("reports an empty day", () => {
    const made = materializeDay({ ids: [], reasons: [] }, input, shortlist, ctx, witnessOf(input));
    expect(made.errors.map((e) => e.code)).toContain("EMPTY_DAY");
  });
});
