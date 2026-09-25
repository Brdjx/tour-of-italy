import { describe, expect, it } from "vitest";
import { OUTING_MIN_MINUTES } from "../src/config";
import { type DaySlot, type FirstChoice, orderDay } from "../src/orderDay";
import { OUTING_LATEST_START } from "../src/planPolicy";
import { scheduleDay } from "../src/schedule";
import type { TripRequest } from "../src/types";
import { makeRequest, realContext, realPlace } from "./plannerFixtures";

// orderDay puts the places the model chose for a day in an order the scheduler can time, with
// the rules-only planner's day walk. These tests pin what it keeps, what it leaves out, and why
// the AI path's tidy step tries both kinds of walk.

const ctx = realContext();
const TUESDAY = "2026-10-20";
const SATURDAY = "2026-01-31";

const COLOSSEUM = "place_001";
const TRASTEVERE = "place_002"; // 180 min
const CAMPO_DE_FIORI = "place_006"; // a morning market, 07:00-13:00
const DA_ENZO = "place_003"; // lunch and dinner, 12:30-14:30 and 19:30-22:30
const PANTHEON = "place_005";
const BORGHESE_GALLERY = "place_007";
const OSTERIA_FERNANDA = "place_009"; // dinner only
const VATICAN_MUSEUMS = "place_010"; // 240 min, 09:00-18:00
const GIOLITTI = "place_011";
const MERCATO_TESTACCIO = "place_015"; // lunch only, 07:00-14:00
const ROMAN_FORUM = "place_004";
const PALATINE_HILL = "place_016";
const SPANISH_STEPS = "place_019";
const IL_SORPASSO = "place_020";
const ROSCIOLI = "place_022"; // lunch and dinner
const APPIAN_WAY_RIDE = "place_021"; // a 240-minute outing
const PIAZZA_DEL_POPOLO_AT_DAWN = "place_023"; // 06:00-10:00
const TREVI_BY_NIGHT = "place_077"; // 20:00-24:00

function slot(date = TUESDAY): DaySlot {
  const anchor = ctx.anchorById.get("rome");
  if (!anchor) throw new Error("no Rome base");
  return { date, anchor, transferMin: 0 };
}

function timed(ids: readonly string[], request: TripRequest, date = TUESDAY) {
  const day = slot(date);
  return scheduleDay(ids, date, day.anchor, request, ctx, day.transferMin);
}

const errorsOf = (ids: readonly string[], request: TripRequest, date = TUESDAY) =>
  timed(ids, request, date).violations.filter((v) => v.severity === "error");

function order(ids: string[], request: TripRequest, date = TUESDAY, first?: FirstChoice) {
  return orderDay(ids, slot(date), request, ctx, first);
}

describe("orderDay", () => {
  it("orders a scrambled day so every place is open and each meal is in its window", () => {
    const request = makeRequest();
    const scrambled = [
      OSTERIA_FERNANDA,
      MERCATO_TESTACCIO,
      VATICAN_MUSEUMS,
      COLOSSEUM,
      TREVI_BY_NIGHT,
    ];
    expect(errorsOf(scrambled, request).length).toBeGreaterThan(0);

    const result = order(scrambled, request);

    expect(result.unfitted).toEqual([]);
    expect([...result.ordered].sort()).toEqual([...scrambled].sort());
    expect(errorsOf(result.ordered, request)).toEqual([]);
    const roles = timed(result.ordered, request).stops.map((s) => [s.placeId, s.role]);
    expect(roles).toContainEqual([MERCATO_TESTACCIO, "lunch"]);
    expect(roles).toContainEqual([OSTERIA_FERNANDA, "dinner"]);
    expect(result.ordered.at(-1)).toBe(TREVI_BY_NIGHT);
  });

  it("fits days the other walk cannot, which is why the tidy step tries both", () => {
    const request = makeRequest({ startDate: SATURDAY });
    const saturday = [BORGHESE_GALLERY, MERCATO_TESTACCIO, GIOLITTI, PANTHEON, COLOSSEUM, DA_ENZO];
    const scrambled = [OSTERIA_FERNANDA, MERCATO_TESTACCIO, VATICAN_MUSEUMS, COLOSSEUM];

    // Waiting for lunch, the planner's picks seat Da Enzo and leave the lunch-only market out.
    expect(order(saturday, request, SATURDAY).unfitted).toContain(MERCATO_TESTACCIO);
    const everyPlace = order(saturday, request, SATURDAY, "every_place");
    expect(everyPlace.unfitted).toEqual([]);
    expect(errorsOf(everyPlace.ordered, request, SATURDAY)).toEqual([]);
    // Taking every place as soon as it can start runs the Vatican Museums through lunch.
    expect(order(scrambled, makeRequest(), TUESDAY, "every_place").unfitted).toEqual([
      MERCATO_TESTACCIO,
    ]);
    expect(order(scrambled, makeRequest()).unfitted).toEqual([]);
  });

  it("seats lunch at a place that serves only lunch, keeping the other for dinner", () => {
    const request = makeRequest();

    const result = order(
      [COLOSSEUM, GIOLITTI, SPANISH_STEPS, MERCATO_TESTACCIO, ROSCIOLI],
      request,
    );

    expect(result.unfitted).toEqual([]);
    const roles = timed(result.ordered, request).stops.map((s) => [s.placeId, s.role]);
    expect(roles).toContainEqual([MERCATO_TESTACCIO, "lunch"]);
    expect(roles).toContainEqual([ROSCIOLI, "dinner"]);
  });

  it("gives a morning-only place its last chance, since the day is the only one it has", () => {
    const request = makeRequest({ interests: ["food"] });

    const result = order(
      [TRASTEVERE, CAMPO_DE_FIORI, COLOSSEUM, IL_SORPASSO, OSTERIA_FERNANDA],
      request,
    );

    expect(result.unfitted).toEqual([]);
    expect(result.ordered[0]).toBe(CAMPO_DE_FIORI);
    expect(errorsOf(result.ordered, request)).toEqual([]);
  });

  it("takes the traveler's must-includes first when they can start now", () => {
    const request = makeRequest({ mustInclude: [PALATINE_HILL] });

    const result = order([ROMAN_FORUM, PALATINE_HILL, COLOSSEUM, IL_SORPASSO], request);

    expect(result.ordered[0]).toBe(PALATINE_HILL);
    expect(errorsOf(result.ordered, request)).toEqual([]);
  });

  it("keeps a place the planner would not choose itself, such as an outing after noon", () => {
    const request = makeRequest();
    expect(realPlace(APPIAN_WAY_RIDE).durationMin).toBeGreaterThanOrEqual(OUTING_MIN_MINUTES);

    const result = order([VATICAN_MUSEUMS, IL_SORPASSO, APPIAN_WAY_RIDE, DA_ENZO], request);

    expect(result.unfitted).toEqual([]);
    const ride = timed(result.ordered, request).stops.find((s) => s.placeId === APPIAN_WAY_RIDE);
    expect(ride?.start).toBeGreaterThan(OUTING_LATEST_START);
  });

  it("returns ids that are not places, and places that cannot fit, as unfitted, each id once", () => {
    const request = makeRequest({ pace: "relaxed" }); // the day starts at 10:00, after dawn

    const result = order(
      [PIAZZA_DEL_POPOLO_AT_DAWN, "place_999", PANTHEON, PANTHEON, IL_SORPASSO],
      request,
    );

    expect(result.ordered).toEqual([PANTHEON, IL_SORPASSO]);
    expect(result.unfitted).toEqual([PIAZZA_DEL_POPOLO_AT_DAWN, "place_999"]);
  });
});
