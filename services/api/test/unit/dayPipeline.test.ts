import { sharesLocation, usedOnOtherDays } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type { LlmDayAnswer } from "../../src/llm/client";
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
    );

    expect(made.errors).toEqual([]);
    expect(made.dayPlan.anchorId).toBe("florence");
    expect(made.dayPlan.transferMin).toBe(130);
    expect(made.dayPlan.stops[0]?.reasonSource).toBe("ai");
    expect(made.reasonStats).toMatchObject({ kept: 1, replaced: 0 });
  });

  it("reports an id the day's shortlist did not offer, and one that is not a place", () => {
    const venice = ctx.anchorById.get("venice")?.placeIds[0] as string;
    const made = materializeDay({ ids: [venice, "place_999"], reasons: [] }, input, shortlist, ctx);
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
    );

    expect(made.errors.map((e) => e.code)).toContain("MUST_INCLUDE_MISSING");
  });

  it("reports an empty day", () => {
    const made = materializeDay({ ids: [], reasons: [] }, input, shortlist, ctx);
    expect(made.errors.map((e) => e.code)).toContain("EMPTY_DAY");
  });
});
