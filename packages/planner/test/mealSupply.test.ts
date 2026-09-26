import { describe, expect, it } from "vitest";
import { buildPlannerContext } from "../src/context";
import { checkDayBase, dayBaseOptions } from "../src/dayBases";
import { planRoute } from "../src/dayRoute";
import {
  dayMealGaps,
  mealFacts,
  mealGaps,
  mealPlaceName,
  mealPlaces,
  mealsMissing,
} from "../src/mealSupply";
import { planDeterministic } from "../src/plan";
import { makeWeek } from "../src/time";
import { scheduleTrip } from "../src/trip";
import type { DayPlan, Itinerary, Place, Stop, TripRequest, Weekday } from "../src/types";
import { makePlace, makeRequest, realContext } from "./plannerFixtures";

// Why a day has no lunch or no dinner (mealSupply.ts). The failure it prevents: the owner's
// Monday in Bologna (2026-09-26) said "Meal missing" and to swap a stop near dinner time, when no
// dinner place of Bologna opens on Mondays, so no swap could ever work. Each missing meal is none
// open (no place the traveler does not avoid can take it that day, with each place's reason) or
// not planned (a place could), and a city that leaves a day with none open says so before it is
// chosen.

const ctx = realContext();

/** A timed stop, as the page and the API hold it. Only the role and the times matter here. */
function stop(placeId: string, role: Stop["role"], start: number, end: number): Stop {
  return { placeId, start, end, travelFromPrevMin: 0, role };
}

function day(date: string, anchorId: string, stops: Stop[], transferMin = 0): DayPlan {
  return { date, anchorId, transferMin, stops };
}

function trip(request: TripRequest, days: DayPlan[]): Pick<Itinerary, "request" | "days"> {
  return { request, days };
}

/** The owner's trip: Rome, Venice, Bologna from Saturday 10 October 2026, as planRoute plans it. */
function ownersTrip(pace: TripRequest["pace"] = "balanced") {
  const request = makeRequest({ startDate: "2026-10-10", pace });
  const base = planDeterministic(request, ctx);
  const days = base.days.map((d) => ({
    anchorId: d.anchorId,
    placeIds: d.stops.map((s) => s.placeId),
  }));
  const plan = planRoute(request, days, ["rome", "venice", "bologna"], ctx);
  if (plan.rulesDays === null) throw new Error("the owner's route was refused");
  return { request, plan, timed: scheduleTrip(request, plan.rulesDays, ctx) };
}

describe("dayMealGaps", () => {
  it("says none of Bologna's dinner places opens on a Monday, naming each and why (the owner's day)", () => {
    const { request, timed } = ownersTrip();
    const gaps = dayMealGaps({ request, days: timed.days }, 2, ctx);

    expect(gaps).toEqual([
      {
        day: 2,
        meal: "dinner",
        cause: "none_open",
        text: "Bologna's three dinner places are all closed on Mondays.",
        places: [
          {
            placeId: "place_043",
            name: "Osteria Francescana",
            town: "Modena",
            block: "closed_weekday",
            why: "closed on Mondays",
            overBudget: false,
            day: null,
          },
          {
            placeId: "place_047",
            name: "Tagliatelle al Ragù at Trattoria Anna Maria",
            town: null,
            block: "closed_weekday",
            why: "closed on Mondays",
            overBudget: false,
            day: null,
          },
          {
            placeId: "place_050",
            name: "Enoteca Italiana, Bologna",
            town: null,
            block: "closed_weekday",
            why: "closed on Mondays",
            overBudget: false,
            day: null,
          },
        ],
      },
    ]);
    // The day has its lunch: Via Drapperie at 12:00, its last start, after the train from Venice.
    expect(timed.days[2]?.stops.find((s) => s.role === "lunch")).toMatchObject({
      placeId: "place_046",
      start: 720,
    });
  });

  it("gives each reason when they differ: a Monday lunch after the train from Rome, relaxed", () => {
    const request = makeRequest({ startDate: "2026-10-11", pace: "relaxed" });
    const plan = [
      day("2026-10-11", "rome", [stop("place_001", "visit", 600, 720)]),
      day("2026-10-12", "bologna", [stop("place_044", "visit", 800, 860)], 155),
      day("2026-10-13", "bologna", [stop("place_045", "visit", 600, 700)]),
    ];

    const [lunch, dinner] = dayMealGaps(trip(request, plan), 1, ctx);

    expect(lunch).toMatchObject({
      meal: "lunch",
      cause: "none_open",
      text: "Of Bologna's three lunch places, two are not reachable in time that day and one is closed on Mondays.",
    });
    expect(lunch?.places.map((p) => [p.placeId, p.block])).toEqual([
      ["place_046", "out_of_reach"],
      ["place_047", "closed_weekday"],
      ["place_092", "out_of_reach"],
    ]);
    expect(dinner).toMatchObject({ meal: "dinner", cause: "none_open" });
  });

  it("counts a place the traveler avoids as one that cannot take the meal", () => {
    // Milan has two lunch places: Trattoria Milanese closes on Mondays, and Rossopomodoro is the
    // one the traveler avoids.
    const request = makeRequest({ startDate: "2026-10-12", exclude: ["place_082"] });
    const plan = [day("2026-10-12", "milan", [stop("place_060", "visit", 600, 700)])];

    const [lunch] = dayMealGaps(trip(request, plan), 0, ctx);

    expect(lunch).toMatchObject({
      cause: "none_open",
      text: "Of Milan's two lunch places, one is closed on Mondays and one is on your avoid list.",
    });
    expect(lunch?.places.find((p) => p.placeId === "place_082")).toMatchObject({
      block: "avoided",
      why: "on your avoid list",
    });
  });

  it("says a meal was not planned when a place could take it, naming the one that is free", () => {
    // Milan on a Tuesday: Trattoria Milanese is lunch on day 1, Rossopomodoro and the aperitivo
    // walk are free for dinner on day 2.
    const request = makeRequest({ startDate: "2026-10-13" });
    const plan = [
      day("2026-10-13", "milan", [stop("place_061", "lunch", 720, 810)]),
      day("2026-10-14", "milan", [stop("place_082", "lunch", 720, 780)]),
    ];

    const [dinner] = dayMealGaps(trip(request, plan), 1, ctx);

    expect(dinner).toMatchObject({
      meal: "dinner",
      cause: "not_planned",
      text: "Aperitivo Culture Walk, Milan could take dinner that day.",
    });
    // Free first, then the ones a day holds, with the day that holds each.
    expect(dinner?.places.map((p) => [p.placeId, p.block, p.day])).toEqual([
      ["place_100", null, null],
      ["place_061", null, 0],
      ["place_082", null, 1],
    ]);
  });

  it("says when every place that could take the meal is already in the trip", () => {
    const request = makeRequest({ startDate: "2026-10-13" });
    const plan = [
      day("2026-10-13", "milan", [stop("place_061", "lunch", 720, 810)]),
      day("2026-10-14", "milan", [stop("place_082", "lunch", 720, 780)]),
      day("2026-10-15", "milan", [stop("place_100", "dinner", 1140, 1260)]),
    ];

    const gaps = dayMealGaps(trip(request, plan), 1, ctx);

    expect(gaps.map((g) => [g.meal, g.cause, g.text])).toEqual([
      [
        "dinner",
        "not_planned",
        "Every place in Milan that could take dinner that day is already in the trip.",
      ],
    ]);
  });

  it("names the town of a place outside the base's city, unless its name already says it", () => {
    // Bologna on a Wednesday at a packed pace, which is back from Modena in time: Trattoria Anna
    // Maria and Enoteca Italiana are on other days, so Osteria Francescana, in Modena, is the one
    // free for dinner. Cantina di Parma says Parma in its name.
    const request = makeRequest({ startDate: "2026-10-13", pace: "packed", maxPriceLevel: 4 });
    const plan = [
      day("2026-10-13", "bologna", [stop("place_047", "dinner", 1140, 1230)]),
      day("2026-10-14", "bologna", [stop("place_044", "visit", 600, 690)]),
      day("2026-10-15", "bologna", [stop("place_050", "dinner", 1140, 1230)]),
    ];

    const dinner = dayMealGaps(trip(request, plan), 1, ctx).find((gap) => gap.meal === "dinner");

    expect(dinner?.text).toBe("Osteria Francescana, Modena could take dinner that day.");
    expect(dinner?.places.map((p) => [p.placeId, p.town])).toEqual([
      ["place_043", "Modena"],
      ["place_047", null],
      ["place_050", null],
    ]);
    const lunch = mealPlaces(request, "bologna", "lunch", "2026-10-14", 570, ctx);
    expect(lunch.map((p) => [p.placeId, mealPlaceName(p)])).toEqual([
      ["place_046", "Via Drapperie, Bologna"],
      ["place_047", "Tagliatelle al Ragù at Trattoria Anna Maria"],
      ["place_092", "Prosciutto di Parma at Cantina di Parma"],
    ]);
  });

  it("says when the places that could take the meal are over the traveler's budget", () => {
    // Venice on Sunday 11 October at the lowest budget: Osteria Alla Staffa closes on Sundays,
    // and Osteria da Rioba (three levels) and Al Quadri (four) are open but over it.
    const request = makeRequest({ startDate: "2026-10-11", maxPriceLevel: 1 });
    const alone = [day("2026-10-11", "venice", [stop("place_066", "visit", 600, 660)])];
    const [lunch] = dayMealGaps(trip(request, alone), 0, ctx);

    expect(lunch).toMatchObject({
      cause: "not_planned",
      text: "Every place in Venice that could take lunch that day is over your budget.",
    });
    expect(lunch?.places.filter((p) => p.block === null).map((p) => p.overBudget)).toEqual([
      true,
      true,
    ]);
    // With Al Quadri on the day before, the one left is over the budget.
    const taken = [
      day("2026-10-10", "venice", [stop("place_096", "lunch", 720, 840)]),
      day("2026-10-11", "venice", [stop("place_066", "visit", 600, 660)]),
    ];
    const [second] = dayMealGaps(trip({ ...request, startDate: "2026-10-10" }, taken), 1, ctx);
    expect(second?.text).toBe(
      "Every place in Venice that could take lunch that day is already in the trip or over your budget.",
    );
  });

  it("counts the places that could take the meal when more than one is free", () => {
    const request = makeRequest({ startDate: "2026-10-20" });
    const plan = [day("2026-10-20", "rome", [stop("place_001", "visit", 570, 690)])];

    const [lunch] = dayMealGaps(trip(request, plan), 0, ctx);

    expect(lunch?.cause).toBe("not_planned");
    expect(lunch?.text).toMatch(/^[A-Z][a-z]+ places in Rome could take lunch that day\.$/);
  });

  it("never counts a place the planner does not suggest as one that could take the meal, unless asked for", () => {
    // Hard Rock Cafe Rome is rated 2.1: neither the planner, the meal code adds nor a swap offers
    // it, so it is not a place that could take lunch (found in review, 2026-09-26).
    const plan = [day("2026-10-20", "rome", [stop("place_001", "visit", 570, 690)])];
    const request = makeRequest({ startDate: "2026-10-20" });

    const [lunch] = dayMealGaps(trip(request, plan), 0, ctx);

    expect(lunch?.text).toBe("Six places in Rome could take lunch that day.");
    expect(lunch?.places.at(-1)).toMatchObject({
      placeId: "place_025",
      block: "low_rating",
      why: "rated below 3.5",
    });
    const asked = { ...request, mustInclude: ["place_025"] };
    const [again] = dayMealGaps(trip(asked, plan), 0, ctx);
    expect(again?.text).toBe("Seven places in Rome could take lunch that day.");
    expect(again?.places.find((p) => p.placeId === "place_025")?.block).toBeNull();
  });

  it("finds a gap exactly where the validator warns: an outing through lunch is lunch, an empty day has none", () => {
    const request = makeRequest({ startDate: "2026-10-20" });
    // The Vatican Museums from 10:00 to 14:00 are under way through lunch.
    const outing = ctx.placesById.get("place_010") as Place;
    expect(outing.durationMin).toBeGreaterThanOrEqual(240);
    const plan = [
      day("2026-10-20", "rome", [stop("place_010", "visit", 600, 840)]),
      day("2026-10-21", "rome", []),
      day("2026-10-22", "rome", [
        stop("place_003", "lunch", 750, 840),
        stop("place_009", "dinner", 1170, 1260),
      ]),
    ];

    expect(mealGaps(trip(request, plan), ctx).map((g) => [g.day, g.meal])).toEqual([[0, "dinner"]]);
    expect(plan.map((one) => mealsMissing(one, ctx))).toEqual([["dinner"], [], []]);
  });

  it("names no cause it cannot know: a base or a date the plan got wrong", () => {
    const request = makeRequest({ startDate: "2026-10-20" });
    const plan = [
      day("2026-10-20", "atlantis", [stop("place_001", "visit", 600, 700)]),
      day("not a date", "rome", [stop("place_002", "visit", 600, 700)]),
    ];

    const gaps = mealGaps(trip(request, plan), ctx);

    expect(gaps).toHaveLength(4);
    for (const gap of gaps)
      expect(gap).toMatchObject({ cause: "not_planned", text: "", places: [] });
  });
});

describe("mealPlaces", () => {
  it("leaves out Osteria Francescana when the traveler cannot be back from Modena in time", () => {
    const request = makeRequest({ pace: "balanced" });
    // Tuesday 13 October, a day with no travel: 09:30 start.
    const places = mealPlaces(request, "bologna", "dinner", "2026-10-13", 570, ctx);

    expect(places.map((p) => [p.placeId, p.block, p.why])).toEqual([
      ["place_043", "out_of_reach", "too far to get back from in time"],
      ["place_047", null, ""],
      ["place_050", null, ""],
    ]);
    expect(mealPlaces(request, "atlantis", "dinner", "2026-10-13", 570, ctx)).toEqual([]);
  });
});

/** A place of Testville, a small base of its own, serving `meals`, open 12:00 to 23:00 daily. */
function testPlace(id: string, overrides: Partial<Place> = {}): Place {
  return makePlace({
    id,
    name: `Test ${id}`,
    city: "Testville",
    lat: 41.9,
    lng: 12.5,
    type: "restaurant",
    mealCapable: true,
    meals: ["lunch", "dinner"],
    durationMin: 90,
    hours: makeWeek([0, 1, 2, 3, 4, 5, 6], [{ open: 720, close: 1380 }]),
    ...overrides,
  });
}

const MONDAY = "2026-10-12";

describe("mealPlaces and mealFacts on hours the real data does not have", () => {
  it("says a season closure, a date rule, hours that hold no meal, and unknown hours as they are", () => {
    const places = [
      testPlace("place_901", {
        dateRules: [
          {
            kind: "season",
            window: { from: { month: 5, day: 1 }, to: { month: 9, day: 30 } },
            source: "summer",
          },
        ],
      }),
      testPlace("place_902", {
        dateRules: [{ kind: "day_of_month", from: 15, to: 21, source: "third week" }],
      }),
      testPlace("place_903", {
        hours: makeWeek([0, 1, 2, 3, 4, 5, 6], [{ open: 540, close: 1080 }]),
      }),
      testPlace("place_904", { hours: null, hoursConfidence: "unknown" }),
      testPlace("place_905", {
        dateRules: [{ kind: "weekdays", days: [5, 6] as Weekday[], source: "weekends" }],
      }),
    ];
    const small = buildPlannerContext(places);
    const request = makeRequest({ startDate: MONDAY });

    const dinner = mealPlaces(request, "testville", "dinner", MONDAY, 570, small);

    expect(dinner.map((p) => [p.placeId, p.block, p.why])).toEqual([
      ["place_901", "closed_date", "closed for the season"],
      ["place_902", "closed_date", "closed on 12 Oct"],
      ["place_903", "hours", "not open for dinner that day"],
      ["place_904", null, ""],
      ["place_905", "closed_weekday", "closed on Mondays"],
    ]);
    // Without the place of unknown hours, no dinner is possible, and the fact gives the date.
    const known = buildPlannerContext(places.filter((p) => p.id !== "place_904"));
    expect(mealFacts(request, "testville", MONDAY, 570, null, known)).toEqual([
      "No dinner in Testville on Mon 12 Oct 2026.",
    ]);
  });

  it("counts past ten in digits, and says when a base has no place for a meal at all", () => {
    const closed = makeWeek([0, 2, 3, 4, 5, 6], [{ open: 1080, close: 1380 }]);
    const places = Array.from({ length: 11 }, (_, i) =>
      testPlace(`place_9${String(i).padStart(2, "0")}`, { meals: ["dinner"], hours: closed }),
    );
    const small = buildPlannerContext(places);
    const request = makeRequest({ startDate: MONDAY });
    const plan = [day(MONDAY, "testville", [stop("place_900", "visit", 600, 690)])];

    const gaps = dayMealGaps(trip(request, plan), 0, small);

    expect(gaps.map((g) => [g.meal, g.cause, g.text])).toEqual([
      ["lunch", "none_open", "Testville has no lunch place."],
      ["dinner", "none_open", "Testville's 11 dinner places are all closed on Mondays."],
    ]);
    expect(mealFacts(request, "testville", MONDAY, 570, null, small)).toEqual([
      "No lunch place in Testville.",
      "No dinner in Testville on Mondays.",
    ]);
  });

  it("says a dinner that would end after the day's window is out of reach, even with time to get back", () => {
    // A relaxed day ends at 22:00; a dinner from 20:45 would end at 22:15, inside the half hour
    // the trip back may take after dinner, but the stop itself must end inside the window.
    const late = testPlace("place_901", {
      meals: ["dinner"],
      hours: makeWeek([0, 1, 2, 3, 4, 5, 6], [{ open: 1245, close: 1410 }]),
    });
    const small = buildPlannerContext([late, testPlace("place_902", { meals: ["lunch"] })]);
    const relaxed = makeRequest({ startDate: MONDAY, pace: "relaxed" });

    expect(mealPlaces(relaxed, "testville", "dinner", MONDAY, 600, small)).toMatchObject([
      { placeId: "place_901", block: "out_of_reach" },
    ]);
    // A balanced day ends at 22:30, so the same dinner fits.
    const balanced = { ...relaxed, pace: "balanced" as const };
    expect(mealPlaces(balanced, "testville", "dinner", MONDAY, 570, small)[0]?.block).toBeNull();
  });

  it("says which day holds a place at the same spot as a meal place", () => {
    const small = buildPlannerContext([
      testPlace("place_901", { meals: ["dinner"], sharedLocationWith: ["place_903"] }),
      testPlace("place_902", { meals: ["lunch"] }),
      testPlace("place_903", { mealCapable: false, meals: [], type: "museum" }),
    ]);
    const request = makeRequest({ startDate: MONDAY });
    const plan = [
      day(MONDAY, "testville", [stop("place_903", "visit", 600, 690)]),
      day("2026-10-13", "testville", [stop("place_902", "lunch", 720, 810)]),
    ];

    const [dinner] = dayMealGaps(trip(request, plan), 1, small);

    expect(dinner).toMatchObject({
      cause: "not_planned",
      text: "Every place in Testville that could take dinner that day is already in the trip.",
    });
    expect(dinner?.places.map((p) => [p.placeId, p.day])).toEqual([["place_901", 0]]);
  });

  it("says none is open when the only place open is one the planner does not suggest", () => {
    const small = buildPlannerContext([
      testPlace("place_901", {
        meals: ["dinner"],
        hours: makeWeek([0, 2, 3, 4, 5, 6], [{ open: 720, close: 1380 }]),
      }),
      testPlace("place_902", { meals: ["dinner"], rating: 2 }),
      testPlace("place_903", { meals: ["lunch"] }),
    ]);
    const request = makeRequest({ startDate: MONDAY });
    const plan = [day(MONDAY, "testville", [stop("place_903", "lunch", 720, 810)])];

    expect(dayMealGaps(trip(request, plan), 0, small)).toMatchObject([
      {
        cause: "none_open",
        text: "Of Testville's two dinner places, one is closed on Mondays and one is rated below 3.5.",
      },
    ]);
    expect(mealFacts(request, "testville", MONDAY, 570, null, small)).toEqual([
      "No dinner in Testville on Mon 12 Oct 2026.",
    ]);
  });

  it("names the one place a base has for a meal", () => {
    const small = buildPlannerContext([
      testPlace("place_901", {
        meals: ["lunch"],
        hours: makeWeek([0, 2, 3, 4, 5, 6], [{ open: 720, close: 900 }]),
      }),
      testPlace("place_902", { meals: ["dinner"] }),
    ]);
    const request = makeRequest({ startDate: MONDAY });
    const plan = [day(MONDAY, "testville", [stop("place_902", "dinner", 1140, 1230)])];

    expect(dayMealGaps(trip(request, plan), 0, small).map((g) => g.text)).toEqual([
      "Testville's only lunch place is closed on Mondays.",
    ]);
  });
});

describe("mealFacts", () => {
  it("warns about the owner's Monday in Bologna before it is planned", () => {
    const { plan } = ownersTrip();

    expect(plan.days.map((d) => d.meals)).toEqual([[], [], ["No dinner in Bologna on Mondays."]]);
  });

  it("says when the travel in leaves no lunch in reach: Rome to Bologna on a Monday, relaxed", () => {
    const request = makeRequest({ startDate: "2026-10-11", pace: "relaxed" });
    // The train from Rome takes 2 h 35 min: the day starts at 12:35, after Via Drapperie's last lunch.
    expect(mealFacts(request, "bologna", MONDAY, 755, "Rome", ctx)).toEqual([
      "No lunch in Bologna after the travel from Rome.",
      "No dinner in Bologna on Mondays.",
    ]);
    // A day in Bologna with no travel has its lunch.
    expect(mealFacts(request, "bologna", MONDAY, 600, null, ctx)).toEqual([
      "No dinner in Bologna on Mondays.",
    ]);
  });

  it("says a meal is gone only because of the places the traveler avoids", () => {
    const request = makeRequest({ startDate: MONDAY, exclude: ["place_082"] });

    expect(mealFacts(request, "milan", MONDAY, 570, null, ctx)).toEqual([
      "No lunch in Milan on Mondays, apart from places you avoid.",
    ]);
    expect(mealFacts(makeRequest(), "milan", MONDAY, 570, null, ctx)).toEqual([]);
    expect(mealFacts(request, "atlantis", MONDAY, 570, null, ctx)).toEqual([]);
  });

  it("gives Sunday lunch in Bologna, the data's other meal no place serves", () => {
    const request = makeRequest({ startDate: "2026-10-11" });

    expect(mealFacts(request, "bologna", "2026-10-11", 570, null, ctx)).toEqual([
      "No lunch in Bologna on Sundays.",
    ]);
  });
});

describe("the cities a day can take", () => {
  it("lists Bologna for the owner's Monday with no dinner as a fact, and still allows it", () => {
    const { request, plan } = ownersTrip();
    const days = plan.rulesDays ?? [];
    const options = dayBaseOptions(request, days, 2, ctx);
    const bologna = options.find((o) => o.anchorId === "bologna");

    expect(bologna).toMatchObject({
      current: true,
      allowed: true,
      meals: ["No dinner in Bologna on Mondays."],
      warnings: [
        "2 h 25 min by train or car from Venice, so the day starts at 11:55.",
        "Leaves about 7 h before dinner.",
        "No dinner in Bologna on Mondays.",
      ],
    });
    expect(options.find((o) => o.anchorId === "florence")?.meals).toEqual([]);
    // Moving day 2 to Bologna (a Sunday): its lunch fact comes before the other day's note.
    const sunday = dayBaseOptions(request, days, 1, ctx).find((o) => o.anchorId === "bologna");
    expect(sunday?.meals).toEqual(["No lunch in Bologna on Sundays."]);
    expect(sunday?.warnings.indexOf("No lunch in Bologna on Sundays.")).toBe(2);
    expect(checkDayBase(request, days, 2, "bologna", ctx).option.meals).toEqual([
      "No dinner in Bologna on Mondays.",
    ]);
  });
});
