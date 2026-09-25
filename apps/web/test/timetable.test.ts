import { type Itinerary, placesOfAnchor, TRAVEL, type Violation } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { boundsOf, mapPoints, markerHtml } from "../lib/mapPoints";
import {
  buildDayView,
  buildTripView,
  DAY_THUMBNAILS,
  dayTimes,
  FREE_TIME_MIN,
  movedStops,
  type RowView,
  stopsText,
  thumbnailRows,
} from "../lib/timetable";
import { ctx, fixturePlan, must, vaticanDay } from "./fixtures";

// The timetable's arithmetic: legs, free time, transfers, flags and chips. A wrong number here
// shows the traveler a wrong plan even when the planner is right.

describe("buildDayView", () => {
  const plan = fixturePlan();

  it("has one row per stop with the leg that leads to it", () => {
    const view = buildDayView(plan, 0, ctx, []);
    const day = must(plan.days[0]);
    expect(view?.rows).toHaveLength(day.stops.length);
    expect(view?.rows[0]?.leg.text).toMatch(/from central Rome$/);
    expect(view?.rows[1]?.leg.minutes).toBe(day.stops[1]?.travelFromPrevMin);
    expect(view?.heading).toBe("Tuesday 6 October");
    expect(view?.tabLabel).toBe("Tue 6 Oct");
    expect(view?.anchorName).toBe("Rome");
  });

  it("shows free time only when the wait is long enough to matter", () => {
    const day = must(plan.days[0]);
    const [first, second] = day.stops;
    if (!first || !second) throw new Error("fixture day too short");
    const waitStart = first.end + second.travelFromPrevMin + TRAVEL.bufferMin + FREE_TIME_MIN + 15;
    const shifted: Itinerary = {
      ...plan,
      days: [
        {
          ...day,
          stops: [
            first,
            { ...second, start: waitStart, end: waitStart + 30 },
            ...day.stops.slice(2),
          ],
        },
        ...plan.days.slice(1),
      ],
    };
    expect(buildDayView(shifted, 0, ctx, [])?.rows[1]?.leg.freeMin).toBe(FREE_TIME_MIN + 15);
    expect(buildDayView(plan, 0, ctx, [])?.rows[1]?.leg.freeMin).toBe(0);
  });

  it("describes the transfer when a day changes base", () => {
    const twoBases = fixturePlan({ anchors: ["rome", "florence"] });
    const views = buildTripView(twoBases, ctx, []);
    const moved = views.find((view) => view.day.transferMin > 0);
    expect(moved?.transfer?.text).toMatch(/^\d.* from (Rome|Florence)$/);
    // Timed like a stop: it leaves at the pace's day start and the day begins on arrival.
    const transfer = must(moved?.transfer, "transfer");
    expect(transfer.arrive - transfer.depart).toBe(moved?.day.transferMin);
    expect(must(moved?.rows[0], "first row").stop.start).toBeGreaterThanOrEqual(transfer.arrive);
    expect(views[0]?.transfer).toBeNull();
  });

  it("counts visits and meals the way the pace limit does", () => {
    const plan = fixturePlan();
    for (const day of plan.days) {
      const visits = day.stops.filter((stop) => stop.role === "visit").length;
      const text = stopsText(day);
      expect(text.startsWith(`${visits} visit`)).toBe(true);
      expect(text.includes("lunch")).toBe(day.stops.some((stop) => stop.role === "lunch"));
      expect(text.includes("dinner")).toBe(day.stops.some((stop) => stop.role === "dinner"));
    }
    const lone = { ...must(plan.days[0]), stops: [] };
    expect(stopsText(lone)).toBe("0 visits");
  });

  it("marks a long visit that stands in for lunch, only on a day with no lunch stop", () => {
    // Decision: pin Rome and find the Vatican day by name, so a change in automatic base choice
    // or day order does not silently remove the case under test.
    const plan = fixturePlan({ pace: "relaxed", interests: [], anchors: ["rome"] });
    const day = vaticanDay(plan);
    const view = must(buildDayView(plan, day, ctx, []));
    const covering = view.rows.filter((row) => row.coveredMeals.length > 0);
    expect(covering.map((row) => row.place?.name)).toEqual(["Vatican Museums"]);
    expect(covering[0]?.coveredMeals).toEqual(["lunch"]);
    expect(view.rows.some((row) => row.stop.role === "lunch")).toBe(false);
    // The validator agrees: no "Meal missing" for lunch on that day.
    expect(
      plan.warnings.some(
        (w) => w.code === "MEAL_MISSING" && w.day === day && w.detail.includes("lunch"),
      ),
    ).toBe(false);
    for (const day of buildTripView(fixturePlan(), ctx, [])) {
      for (const row of day.rows) {
        for (const meal of row.coveredMeals) {
          expect(day.rows.some((other) => other.stop.role === meal)).toBe(false);
        }
      }
    }
  });

  it("flags exactly the stop an error points at, and lists day-level problems", () => {
    const error: Violation = {
      code: "CLOSED_AT_TIME",
      severity: "error",
      day: 0,
      stopIndex: 1,
      placeId: plan.days[0]?.stops[1]?.placeId,
      detail: "Closed then.",
    };
    const dayWarning: Violation = {
      code: "MEAL_MISSING",
      severity: "warning",
      day: 0,
      detail: "No lunch.",
    };
    const view = buildDayView({ ...plan, warnings: [dayWarning] }, 0, ctx, [error]);
    expect(view?.rows.map((row) => row.flagged)).toEqual(view?.rows.map((_, index) => index === 1));
    expect(view?.rows[1]?.chips[0]).toMatchObject({ tone: "error", label: "Closed at this time" });
    expect(view?.dayChips).toEqual([expect.objectContaining({ label: "Meal missing" })]);
  });

  it("returns null for a day that does not exist and survives an unknown place id", () => {
    expect(buildDayView(plan, 7, ctx, [])).toBeNull();
    const day = must(plan.days[0]);
    const ghost: Itinerary = {
      ...plan,
      days: [
        { ...day, stops: [{ ...must(day.stops[0]), placeId: "place_gone" }] },
        ...plan.days.slice(1),
      ],
    };
    const view = buildDayView(ghost, 0, ctx, []);
    expect(view?.rows[0]?.place).toBeUndefined();
    expect(view?.rows[0]?.leg.text).toContain("from central Rome");
  });

  it("describes the ride back to base when the planner reports it", () => {
    const day = must(plan.days[0]);
    const withReturn = { ...plan, days: [{ ...day, returnTravelMin: 15 }, ...plan.days.slice(1)] };
    expect(buildDayView(withReturn, 0, ctx, [])?.returnLeg).toMatch(
      /^15 min .* back to central Rome$/,
    );
    const zero = { ...plan, days: [{ ...day, returnTravelMin: 0 }, ...plan.days.slice(1)] };
    expect(buildDayView(zero, 0, ctx, [])?.returnLeg).toBe("Ends in central Rome");
    const { returnTravelMin: _omitted, ...withoutReturn } = day;
    const none = { ...plan, days: [withoutReturn, ...plan.days.slice(1)] };
    expect(buildDayView(none, 0, ctx, [])?.returnLeg).toBeNull();
  });
});

describe("thumbnailRows", () => {
  const rows = must(buildDayView(fixturePlan(), 0, ctx, [])).rows;
  /** The rows with their ratings replaced, so the ranking is under the test's control. */
  const rated = (ratings: (number | null)[]): RowView[] =>
    ratings.map((rating, index) => {
      const row = must(rows[index % rows.length]);
      return { ...row, index, place: { ...must(row.place), rating } };
    });
  const every = () => true;

  it("picks the day's highest-rated stops, at most two", () => {
    expect(DAY_THUMBNAILS).toBe(2);
    expect([...thumbnailRows(rated([4.2, 4.9, 4.5, 4.8]), every)].sort()).toEqual([1, 3]);
  });

  it("breaks a tie by visiting order and ranks a missing rating last", () => {
    expect([...thumbnailRows(rated([4.7, 4.7, 4.7]), every)].sort()).toEqual([0, 1]);
    expect([...thumbnailRows(rated([null, 3.1, null]), every)].sort()).toEqual([0, 1]);
  });

  it("only picks stops with a photo of their own", () => {
    const withPhoto = new Set(["place_x"]);
    const ratings = rated([4.9, 4.1, 4.8]).map((row, index) =>
      index === 1 ? { ...row, place: { ...must(row.place), id: "place_x" } } : row,
    );
    const picked = thumbnailRows(ratings, (place) => withPhoto.has(place.id));
    expect([...picked]).toEqual([1]);
    expect(thumbnailRows([{ ...must(rows[0]), place: undefined }], every).size).toBe(0);
  });
});

describe("movedStops", () => {
  const rows = must(buildDayView(fixturePlan(), 0, ctx, [])).rows;
  const shifted = (index: number, by: number): RowView[] =>
    rows.map((row) =>
      row.index === index
        ? { ...row, stop: { ...row.stop, start: row.stop.start + by, end: row.stop.end + by } }
        : row,
    );

  it("names only the stops whose times changed", () => {
    const moved = movedStops(dayTimes(rows), dayTimes(shifted(1, 15)));
    expect([...moved]).toEqual([rows[1]?.stop.placeId]);
    expect(movedStops(dayTimes(rows), dayTimes(rows)).size).toBe(0);
  });

  it("never flips a stop that is new to the day, or anything on a first render", () => {
    expect(movedStops("", dayTimes(rows)).size).toBe(0);
    const swapped = rows.map((row, index) =>
      index === 0 ? { ...row, stop: { ...row.stop, placeId: "place_new", start: 1 } } : row,
    );
    expect(movedStops(dayTimes(rows), dayTimes(swapped)).size).toBe(0);
  });
});

describe("mapPoints", () => {
  it("numbers markers in visiting order and marks repaired locations as approximate", () => {
    const plan = fixturePlan();
    const day = must(plan.days[0]);
    const points = mapPoints(day, ctx);
    expect(points.map((point) => point.number)).toEqual(day.stops.map((_, index) => index + 1));
    const brera = mapPoints(
      { ...day, anchorId: "milan", stops: [{ ...must(day.stops[0]), placeId: "place_059" }] },
      ctx,
    );
    expect(brera[0]?.approximate).toBe(true);
    expect(points.every((point) => point.approximate === false)).toBe(true);
  });

  it("keeps numbering aligned with the list when a stop is unknown", () => {
    const day = must(fixturePlan().days[0]);
    const withGhost = {
      ...day,
      stops: [{ ...must(day.stops[0]), placeId: "place_gone" }, ...day.stops.slice(1)],
    };
    expect(mapPoints(withGhost, ctx)[0]?.number).toBe(2);
  });

  it("computes bounds, and none for an empty day", () => {
    const rome = placesOfAnchor(ctx, "rome").slice(0, 3);
    const points = rome.map((p, index) => ({
      number: index + 1,
      placeId: p.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      approximate: false,
    }));
    const bounds = boundsOf(points);
    expect(bounds?.[0][0]).toBe(Math.min(...rome.map((p) => p.lat)));
    expect(bounds?.[1][1]).toBe(Math.max(...rome.map((p) => p.lng)));
    expect(boundsOf([])).toBeNull();
  });

  it("puts only a number into marker HTML, never a place name", () => {
    expect(markerHtml({ number: 3, approximate: false })).toBe(
      '<span class="map-marker" aria-hidden="true">3</span>',
    );
    expect(markerHtml({ number: 2.7, approximate: true })).toContain("map-marker--approximate");
    expect(markerHtml({ number: -1, approximate: false })).toContain(">0<");
  });
});
