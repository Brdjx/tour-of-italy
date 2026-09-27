import {
  type Itinerary,
  placesOfAnchor,
  rescheduleDay,
  TRAVEL,
  type Violation,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  boundsOf,
  type MapPoint,
  mapDayTitle,
  mapPoints,
  roleWord,
  stopCountText,
  stopLabel,
  stopTimes,
} from "../lib/mapPoints";
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
import { ctx, fixturePlan, must, ownersMonday, vaticanDay } from "./fixtures";

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
    // What the travel leaves of the day, in the route sheet's words (decision 16): the time from
    // arrival to the dinner window at 19:00, rounded down to the half hour.
    const left = Math.floor((19 * 60 - transfer.arrive) / 30) * 30;
    const hours = Math.floor(left / 60);
    const minutes = left % 60;
    expect(transfer.left).toBe(
      `Leaves about ${hours} h${minutes > 0 ? ` ${minutes} min` : ""} before dinner.`,
    );
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

// Venice: no taxi or bus runs in the lagoon, so a local leg there goes by water bus on every
// line the day shows (the planner's travelLabelBetween).
describe("a day in Venice", () => {
  const plan = fixturePlan({ anchors: ["venice"] });
  const day = must(plan.days[0]);
  const others = day.stops.map((stop) => stop.placeId).filter((id) => id !== "place_088");
  /** Day 1 with San Giorgio Maggiore, on its own island, moved to `at` in the order. */
  const withIsland = (at: "first" | "last") => {
    const order = at === "first" ? ["place_088", ...others] : [...others, "place_088"];
    return must(buildDayView(rescheduleDay(plan, 0, order, ctx).itinerary, 0, ctx, []));
  };

  it("says by vaporetto from central Venice, between stops and back to the base", () => {
    const first = withIsland("first");
    const island = must(first.rows[0]);
    expect(island.stop.placeId).toBe("place_088");
    expect(island.leg.text).toBe(`${island.leg.minutes} min by vaporetto from central Venice`);
    const next = must(first.rows[1]);
    expect(next.leg.text).toBe(`${next.leg.minutes} min by vaporetto`);
    const last = withIsland("last");
    expect(last.rows.at(-1)?.stop.placeId).toBe("place_088");
    expect(last.returnLeg).toBe(
      `${last.day.returnTravelMin} min by vaporetto back to central Venice`,
    );
  });

  it("never says taxi or bus on any line of a Venice trip, and keeps its walks", () => {
    const lines = buildTripView(plan, ctx, []).flatMap((view) => [
      ...view.rows.map((row) => row.leg.text),
      view.returnLeg ?? "",
    ]);
    expect(lines.filter((line) => line.includes("by vaporetto")).length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.endsWith(" walk")).length).toBeGreaterThan(0);
    expect(lines.filter((line) => /taxi|bus\b/.test(line))).toEqual([]);
  });
});

// The owner's day 3 (decision 17): Monday 12 October in Bologna after the train from Venice, where
// none of Bologna's dinner places opens on Mondays.
describe("a day with no lunch or dinner", () => {
  const trip = ownersMonday();

  it("says no dinner is open on the owner's Monday in Bologna, with the places and the way out", () => {
    const view = must(buildDayView(trip, 2, ctx, []));
    expect(view.anchorName).toBe("Bologna");
    expect(view.dayChips).toEqual([
      expect.objectContaining({
        label: "No dinner open",
        explanation: "The three dinner places listed for Bologna are all closed on Mondays.",
        action: "city",
      }),
    ]);
    expect(view.dayChips[0]?.places?.map((place) => place.name)).toEqual([
      "Osteria Francescana, Modena",
      "Tagliatelle al Ragù at Trattoria Anna Maria",
      "Enoteca Italiana, Bologna",
    ]);
    // No dinner to have, so the transfer does not count the hours left before it.
    expect(view.transfer).toMatchObject({ text: "2 h 25 min by train or car from Venice" });
    expect(view.transfer?.left).toBeNull();
  });

  it("keeps what the travel leaves on a day that can have dinner", () => {
    const view = must(buildDayView(trip, 1, ctx, []));
    expect(view.transfer?.left).toBe("Leaves about 6 h before dinner.");
    expect(view.dayChips.map((chip) => chip.label)).toEqual(["Long transfer"]);
  });

  it("offers the swap once the traveler takes off a dinner another place could take", () => {
    const venice = must(trip.days[1]);
    const kept = venice.stops.filter((stop) => stop.role !== "dinner").map((stop) => stop.placeId);
    const edited = rescheduleDay(trip, 1, kept, ctx).itinerary;
    // With the plan before the edit as the one Undo brings back, as the page passes it.
    const view = must(buildDayView(edited, 1, ctx, [], trip));
    const chip = view.dayChips.find((one) => one.label === "No dinner planned");
    // A dinner the day could still have: the transfer keeps the hours left before it.
    expect(view.transfer?.left).toBe("Leaves about 6 h before dinner.");
    expect(chip?.explanation).toMatch(/^\w+ places in Venice could take dinner that day\.$/);
    expect(chip?.places?.length).toBeGreaterThan(1);
    expect(chip?.wayOut).toBe(
      "Swap a stop near dinner time for one of them, or undo your last change.",
    );
    expect(chip?.action).toBeUndefined();
    // With no Undo on screen, or one that would not bring a dinner back, it is not named.
    const emptied = { ...trip, days: trip.days.map((d, i) => (i === 1 ? { ...d, stops: [] } : d)) };
    for (const before of [null, edited, emptied]) {
      const again = must(buildDayView(edited, 1, ctx, [], before));
      expect(again.dayChips.find((one) => one.label === "No dinner planned")?.wayOut).toBe(
        "Swap a stop near dinner time for one of them.",
      );
    }
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

  it("carries each stop's times and role, as the board shows them", () => {
    const day = must(fixturePlan().days[0]);
    const points = mapPoints(day, ctx);
    expect(points.map(({ start, end, role }) => ({ start, end, role }))).toEqual(
      day.stops.map(({ start, end, role }) => ({ start, end, role })),
    );
  });

  it("names a stop like its row: number, place, times, and the meal or an approximate place", () => {
    const point: MapPoint = {
      number: 2,
      placeId: "place_002",
      name: "Borghese Gallery",
      lat: 41.914,
      lng: 12.492,
      approximate: false,
      start: 650,
      end: 770,
      role: "visit",
    };
    expect(stopTimes(point)).toBe("10:50 to 12:50");
    expect(stopLabel(point)).toBe("Stop 2, Borghese Gallery, 10:50 to 12:50");
    expect(stopLabel({ ...point, role: "lunch" })).toBe(
      "Stop 2, Borghese Gallery, 10:50 to 12:50, lunch",
    );
    expect(stopLabel({ ...point, role: "dinner", approximate: true })).toBe(
      "Stop 2, Borghese Gallery, 10:50 to 12:50, dinner, approximate location",
    );
    expect([roleWord("visit"), roleWord("lunch"), roleWord("dinner")]).toEqual([
      "Visit",
      "Lunch",
      "Dinner",
    ]);
  });

  it("titles the full-screen map with the day, its date and its base, and counts its stops", () => {
    expect(mapDayTitle({ index: 0, tabLabel: "Fri 9 Oct", anchorName: "Rome" })).toBe(
      "Day 1, Fri 9 Oct, Rome",
    );
    expect(stopCountText(6)).toBe("6 stops, numbered in visiting order");
    expect(stopCountText(1)).toBe("1 stop, numbered in visiting order");
  });
});
