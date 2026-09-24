import { describe, expect, it } from "vitest";
import { PACE, TRAVEL } from "../src/config";
import { isOuting } from "../src/constraints";
import { daylightEnd } from "../src/dayRules";
import { planDeterministic } from "../src/plan";
import { AFTER_NOON_NAME, MAX_IDLE_MIN, OUTING_LATEST_START } from "../src/planPolicy";
import { shortenRoutes } from "../src/route";
import { scheduleDay } from "../src/schedule";
import { tripDates } from "../src/time";
import { chooseTrip, type TripDraft } from "../src/tripBuilder";
import type { Stop, TripRequest } from "../src/types";
import { makeRequest, realContext } from "./plannerFixtures";

// The route pass reorders a day to travel less. The failures it must never cause: a day with an
// error, a meal that becomes a visit, a day that starts later or ends later, a lunch lost when an
// outing moves off the lunch window. The failure it prevents: crossing a city twice.

const ctx = realContext();
const request = makeRequest({ startDate: "2026-10-20", anchors: ["rome"] });
const dates = tripDates(request.startDate);

function timed(ids: readonly string[], index = 0) {
  const rome = ctx.anchorById.get("rome");
  if (!rome) throw new Error("no Rome base");
  return scheduleDay(ids, dates[index] ?? "", rome, request, ctx, 0);
}

function travel(ids: readonly string[]): number {
  const day = timed(ids);
  return day.stops.reduce((sum, stop) => sum + stop.travelFromPrevMin, day.returnTravelMin);
}

function draftOf(first: string[]): TripDraft {
  return {
    anchorIds: ["rome", "rome", "rome"],
    days: [first, ["place_001"], ["place_007"]],
    score: 0,
  };
}

describe("shortenRoutes", () => {
  it("never crosses the city twice when the same stops in another order travel less", () => {
    // Pantheon, the Aventine keyhole across town, Piazza Navona back next to the Pantheon, then
    // the Mouth of Truth next to the keyhole: 70 minutes of travel where 50 will do.
    const backtracking = ["place_005", "place_014", "place_008", "place_012"];
    const shortened = shortenRoutes(draftOf(backtracking), request, ctx, dates).days[0] ?? [];
    expect([...shortened].sort()).toEqual([...backtracking].sort());
    expect(travel(shortened)).toBeLessThan(travel(backtracking));
    expect(shortened).toEqual(["place_005", "place_008", "place_014", "place_012"]);
    expect(timed(shortened).violations.filter((v) => v.severity === "error")).toEqual([]);
  });

  it("never turns a meal into a visit, starts the day later, or ends it later", () => {
    const withLunch = ["place_005", "place_014", "place_022", "place_008", "place_002"];
    const before = timed(withLunch);
    const shortened = shortenRoutes(draftOf(withLunch), request, ctx, dates).days[0] ?? [];
    const after = timed(shortened);
    const role = (day: typeof before, id: string) => day.stops.find((s) => s.placeId === id)?.role;
    for (const id of withLunch) expect(role(after, id), id).toBe(role(before, id));
    expect(after.stops[0]?.start ?? 0).toBeLessThanOrEqual(before.stops[0]?.start ?? 0);
    const end = (day: typeof before) => (day.stops.at(-1)?.end ?? 0) + day.returnTravelMin;
    expect(end(after)).toBeLessThanOrEqual(end(before));
  });

  it("never touches a day that already has an error, or a day too short to reorder", () => {
    const closedMonday = { ...request, startDate: "2026-10-19" }; // Borghese Gallery is closed
    const draft = draftOf(["place_007", "place_014", "place_005"]);
    const monday = tripDates(closedMonday.startDate);
    expect(shortenRoutes(draft, closedMonday, ctx, monday).days[0]).toEqual(draft.days[0]);
    expect(shortenRoutes(draft, request, ctx, dates).days[1]).toEqual(["place_001"]);
  });
});

/** The longest wait before a daytime stop other than dinner, counted independently. */
function longestDaytimeWait(stops: readonly Stop[], dayStart: number): number {
  let longest = 0;
  let free = dayStart;
  stops.forEach((stop, index) => {
    const arrive = free + stop.travelFromPrevMin + (index === 0 ? 0 : TRAVEL.bufferMin);
    if (stop.role !== "dinner" && stop.start < 18 * 60) {
      longest = Math.max(longest, stop.start - arrive);
    }
    free = stop.end;
  });
  return longest;
}

describe("shortenRoutes and the traveler's time", () => {
  /** Each day of the walk's draft and of the routed draft, timed. */
  function walkAndRoute(request: TripRequest) {
    const dates = tripDates(request.startDate);
    const walked = chooseTrip(request, ctx, dates);
    if (!walked) throw new Error("no trip");
    const time = (draft: TripDraft) =>
      draft.days.map((ids, index) => {
        const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
        if (!anchor) throw new Error("unknown base");
        return scheduleDay(ids, dates[index] ?? "", anchor, request, ctx, 0).stops;
      });
    return { walk: time(walked), route: time(shortenRoutes(walked, request, ctx, dates)) };
  }

  it.each([
    ["2026-07-20", ["views", "romantic"]],
    ["2026-01-05", []],
  ])(
    "never leaves a Venice morning empty to save a few minutes of walking (%s)",
    (startDate, interests) => {
      // Review finding: the pass moved the Guggenheim from 10:00 to 14:20, so a packed day had
      // the Rialto at 08:35 and nothing else until lunch at 12:00.
      const request = makeRequest({ startDate, pace: "packed", interests, anchors: ["venice"] });
      const { walk, route } = walkAndRoute(request);
      route.forEach((stops, index) => {
        const was = longestDaytimeWait(walk[index] ?? [], PACE.packed.dayStart);
        const cap = Math.max(was, MAX_IDLE_MIN);
        expect(
          longestDaytimeWait(stops, PACE.packed.dayStart),
          `day ${index + 1}`,
        ).toBeLessThanOrEqual(cap);
      });
    },
  );

  it("never puts gelato right before lunch to save a few minutes of walking (Rome, relaxed)", () => {
    // Review finding: Roman Forum 10:10, Gelato at Giolitti 12:05, lunch at Mercato Testaccio.
    for (const startDate of ["2026-01-02", "2026-01-05"]) {
      const request = makeRequest({ startDate, pace: "relaxed", anchors: ["rome"] });
      for (const stops of walkAndRoute(request).route) {
        stops.forEach((stop, index) => {
          const place = ctx.placesById.get(stop.placeId);
          if (!place || !AFTER_NOON_NAME.test(place.name)) return;
          expect(stops[index + 1]?.role, `${startDate} ${place.name}`).not.toBe("lunch");
        });
      }
    }
  });
});

describe("shortenRoutes with a must-include the traveler asked for", () => {
  // Review repros: the walk timed each must-include outing in the morning and the route pass
  // moved it later to save travel, because only ordinary stops counted as breaking a day rule.
  const REPROS: [string, Partial<TripRequest>][] = [
    ["place_070", { startDate: "2026-01-06", pace: "relaxed", anchors: ["venice"] }],
    ["place_010", { startDate: "2026-04-20", anchors: ["rome"], mustInclude: ["place_013"] }],
    ["place_021", { startDate: "2027-08-27", pace: "relaxed", maxPriceLevel: 3 }],
    ["place_021", { startDate: "2027-12-09", interests: ["quiet"] }],
  ];

  /** The must-include's stop in each day of a draft, timed as the plan would time it. */
  function timedStop(draft: TripDraft, request: TripRequest, id: string) {
    const dates = tripDates(request.startDate);
    const index = draft.days.findIndex((ids) => ids.includes(id));
    const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
    if (!anchor) throw new Error(`${id} is not in the draft`);
    const day = scheduleDay(draft.days[index] ?? [], dates[index] ?? "", anchor, request, ctx, 0);
    const stop = day.stops.find((s) => s.placeId === id);
    if (!stop) throw new Error(`${id} was not timed`);
    return { stop, date: dates[index] ?? "" };
  }

  it.each(REPROS)(
    "never moves requested outing %s past noon or after sunset to save travel",
    (id, overrides) => {
      const request = makeRequest({
        ...overrides,
        mustInclude: [id, ...(overrides.mustInclude ?? [])],
      });
      const dates = tripDates(request.startDate);
      const draft = chooseTrip(request, ctx, dates);
      if (!draft) throw new Error("no trip");
      const place = ctx.placesById.get(id);
      if (!place) throw new Error(`no place ${id}`);
      const walked = timedStop(draft, request, id);
      const routed = timedStop(shortenRoutes(draft, request, ctx, dates), request, id);
      expect(isOuting(place)).toBe(true);
      expect(routed.stop.start).toBeLessThanOrEqual(
        Math.max(walked.stop.start, OUTING_LATEST_START),
      );
      const sunset = daylightEnd(place, routed.date);
      expect(routed.stop.end).toBeLessThanOrEqual(Math.max(walked.stop.end, sunset));
      const planned = planDeterministic(request, ctx).days.flatMap((day) => day.stops);
      const final = planned.find((stop) => stop.placeId === id);
      expect(final?.start ?? 0).toBeLessThanOrEqual(OUTING_LATEST_START);
    },
  );
});
