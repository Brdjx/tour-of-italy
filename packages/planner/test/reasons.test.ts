import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REASON_MAX_CHARS } from "../src/config";
import { anchorOfPlace } from "../src/context";
import { isHoliday } from "../src/dayRules";
import { planDeterministic } from "../src/plan";
import {
  EVENING_STARTS,
  isHighestRated,
  MORNING_ENDS,
  type ReasonDay,
  ruleReason,
  SOON_AFTER_OPENING_MIN,
  type TripDays,
} from "../src/reasons";
import { addDays, makeWeek, openStatusOn, WEEKDAY_LONG, weekdayOf } from "../src/time";
import type { DataIssue, Itinerary, Place, StopRole } from "../src/types";
import { FC_SETTINGS, makePlace, makeRequest, realContext, realPlace } from "./plannerFixtures";

// Rule reasons are shown on every deterministic stop and replace any AI reason the API drops
// (failure vector F3). They must be true to the data, never name another place, never exceed the
// length limit, and never contain the clock times, durations, or prices the AI sanitizer rejects,
// or a dropped AI reason would be replaced by one that is dropped too. What a line says about the
// stop's date is checked here against the planner's own hours answers; the real sanitizer runs
// over them in services/api/test/unit/ruleReasons.test.ts.

const none = { interests: [], mustInclude: [] };
const ROLES: StopRole[] = ["visit", "lunch", "dinner"];
const EM_DASH = String.fromCharCode(0x2014);
const SANITIZER_REJECTS = /\d{1,2}[:.]\d{2}|\d\s*(am|pm|h|min|€|euro)\b|€/i;
// The hours wording the AI sanitizer rejects (services/api textGuards.ts HOURS_OR_PRICE_WORDS).
const HOURS_WORDS =
  /\bopen(s|ing)?\s+(until|till|from|at|on|daily|every|late|early|only|between|before|after|to|hours|times?|year)\b|\b(is|are|stays?|remains?|be)\s+open\b|\bclos(es|ed|ing|ures?)\b|\bhours?\b|\bminutes?\b/i;

const at = (hour: number, minute = 0) => hour * 60 + minute;
const FRI = "2026-10-09";
const SAT = "2026-10-10";
const SUN = "2026-10-11";
const MON = "2026-10-12";

/** A trip of these dates, every day at `anchorId` unless `bases` says otherwise. */
function tripOf(dates: string[], index: number, anchorId = "rome", bases: string[] = []): TripDays {
  return { days: dates.map((date, i) => ({ date, anchorId: bases[i] ?? anchorId })), index };
}

/** The stop on day `index` of the trip, from `start` to `end`. */
function onDay(trip: TripDays, start: number, end: number, extra: Partial<ReasonDay> = {}) {
  const date = trip.days[trip.index]?.date as string;
  return { date, start, end, trip, ...extra };
}

describe("ruleReason wording", () => {
  it.each([
    [
      "place_003",
      { interests: ["food", "wine"], mustInclude: [] },
      "Matches your interest in food. Listed as a local favorite. Rated 4.6 out of 5.",
    ],
    [
      "place_010",
      { interests: [], mustInclude: ["place_010"] },
      "You asked to include this. Listed as iconic. Rated 4.7 out of 5.",
    ],
    ["place_026", none, "Listed as iconic. Rated 4.8 out of 5."],
    ["place_002", none, "Listed as a local favorite. Rated 4.7 out of 5."],
    ["place_011", none, "Listed as iconic and a local favorite. Rated 4.3 out of 5."],
  ])("explains visit %s from its own data only", (id, request, text) => {
    expect(ruleReason(realPlace(id), request, "visit")).toBe(text);
  });

  it("reads a tag as what the data lists, never as the planner's own opinion", () => {
    const text = ruleReason(realPlace("place_002"), none, "visit");
    expect(text).toContain("Listed as a local favorite.");
    expect(text).not.toMatch(/(^|\. )A local favorite\./);
  });

  it("never names a tag twice when it is also a matched interest", () => {
    const giolitti = realPlace("place_011");
    expect(ruleReason(giolitti, { interests: ["local-favorite"], mustInclude: [] }, "visit")).toBe(
      "Matches your interest in local favorite. Listed as iconic. Rated 4.3 out of 5.",
    );
  });

  it("says a meal is close to the previous stop only when that stop is a walk away", () => {
    const enzo = realPlace("place_003");
    const request = { interests: ["food"], mustInclude: [] };
    expect(ruleReason(enzo, request, "dinner", realPlace("place_002"))).toBe(
      "Close to your previous stop. Matches your interest in food. Listed as a local favorite. Rated 4.6 out of 5.",
    );
    expect(ruleReason(enzo, request, "lunch", realPlace("place_026"))).toBe(
      "Matches your interest in food. Listed as a local favorite. Rated 4.6 out of 5.",
    );
    expect(ruleReason(enzo, request, "lunch", null)).not.toContain("close to");
    expect(ruleReason(enzo, request, "visit", realPlace("place_002"))).not.toContain("Close to");
  });

  it("never opens a meal with the meal, type and area the row already prints", () => {
    const market = { interests: ["market", "food", "budget", "morning"], mustInclude: [] };
    expect(ruleReason(realPlace("place_015"), market, "lunch")).toBe(
      "Matches your interest in market, food and budget. Listed as a local favorite. Rated 4.7 out of 5.",
    );
    expect(ruleReason(realPlace("place_068"), none, "dinner", realPlace("place_075"))).toBe(
      "Close to your previous stop. Listed as a local favorite. Rated 4.8 out of 5.",
    );
  });

  it("never says 'Dinner in Ostiense' for Eataly: the meal and area are on the row", () => {
    const eataly = realPlace("place_099");
    expect(eataly.type).toBe("shop");
    expect(ruleReason(eataly, none, "dinner")).toBe("Rated 4.1 out of 5.");
    expect(ruleReason(eataly, none, "lunch")).not.toContain("Ostiense");
  });

  it.each([
    [4.75, "Rated 4.8 out of 5."],
    [5, "Rated 5 out of 5."],
    [0, "Rated 0 out of 5."],
  ])("rounds a rating of %s to one decimal: %j", (rating, sentence) => {
    expect(ruleReason(makePlace({ rating }), none, "visit")).toContain(sentence);
  });

  it("falls back to 'Suggested stop.' when the place has no rating and nothing else applies", () => {
    const text = ruleReason(makePlace({ rating: null }), none, "visit");
    expect(text).toBe("Suggested stop.");
  });

  it("makes no closeness claim when the previous position is not a real coordinate", () => {
    const text = ruleReason(realPlace("place_003"), none, "dinner", { lat: Number.NaN, lng: 12 });
    expect(text).toBe("Listed as a local favorite. Rated 4.6 out of 5.");
  });

  it("names at most three matched interests so the sentence stays readable", () => {
    const place = makePlace({ tags: ["art", "food", "wine", "views"] });
    const text = ruleReason(
      place,
      { interests: ["art", "food", "wine", "views"], mustInclude: [] },
      "visit",
    );
    expect(text).toContain("Matches your interest in art, food and wine.");
  });
});

describe("ruleReason guarantees over the real data", () => {
  const places = realContext().places;
  const allTags = [...new Set(places.flatMap((p) => p.tags))];
  const otherNames = (id: string) =>
    places
      .filter((p) => p.id !== id)
      .flatMap((p) => [p.name, p.name.split(",")[0] ?? p.name])
      .map((name) => name.trim().toLowerCase());

  it("never names another place, whatever the role, interests, or previous stop", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: places.length - 1 }),
        fc.nat({ max: places.length - 1 }),
        fc.constantFrom(...ROLES),
        fc.subarray(allTags, { maxLength: 8 }),
        fc.boolean(),
        (i, j, role, interests, must) => {
          const place = places[i];
          const prev = places[j];
          if (!place || !prev) return;
          const request = { interests, mustInclude: must ? [place.id] : [] };
          const text = ruleReason(place, request, role, prev).toLowerCase();
          for (const name of otherNames(place.id)) expect(text.includes(name)).toBe(false);
        },
      ),
      { ...FC_SETTINGS, numRuns: 200 },
    );
  });

  it("never restates the meal, type and area the row prints", () => {
    for (const place of places) {
      for (const role of ROLES) {
        const request = { interests: place.tags, mustInclude: [place.id] };
        const text = ruleReason(place, request, role, place);
        expect(text).not.toMatch(/^(Lunch|Dinner) (at|in)\b/);
        expect(text).not.toContain(` in ${place.city}.`);
        if (place.neighborhood) expect(text).not.toContain(` in ${place.neighborhood}`);
      }
    }
  });

  it("stays within the length limit and passes the AI reason sanitizer for every place and role", () => {
    for (const place of places) {
      for (const role of ROLES) {
        const request = { interests: place.tags, mustInclude: [place.id] };
        for (const day of [undefined, ...daysOfAWeek(place)]) {
          const text = ruleReason(place, request, role, place, day);
          expect(text.length).toBeGreaterThan(0);
          expect(text.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
          expect(text).not.toMatch(SANITIZER_REJECTS);
          expect(text).not.toMatch(HOURS_WORDS);
          expect(text).not.toContain(EM_DASH);
          expect(text.endsWith(".")).toBe(true);
        }
      }
    }
  });
});

/**
 * The place on each day of one week, as the middle day of a trip at its base: timed at each
 * opening that date (and a little after), or through the day when it has no listed hours.
 */
function daysOfAWeek(place: Place): ReasonDay[] {
  const anchorId = anchorOfPlace(realContext(), place.id)?.id ?? "rome";
  const out: ReasonDay[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(FRI, offset);
    const trip = tripOf([addDays(date, -1), date, addDays(date, 1)], 1, anchorId);
    const status = openStatusOn(place, date);
    const opens = status.state === "open" ? status.ranges.map((range) => range.open) : [at(9)];
    for (const open of opens) {
      for (const start of [open, open + 30]) {
        const end = start + place.durationMin;
        out.push(onDay(trip, start, end, { seated: [], highestRated: true }));
      }
    }
  }
  return out;
}

describe("ruleReason about the stop's date", () => {
  // Sant'Ambrogio, Milan: 10:00 to 12:00 and 14:30 to 18:00, shut on Sundays, rated 4.6. A visit
  // from 15:45 is well after it reopens, so only the trip sentence is about the date.
  const ambrogio = realPlace("place_098");
  const afternoon = [at(15, 45), at(16, 45)] as const;
  const weekend = [FRI, SAT, SUN];

  it("names the trip's day the place is shut, and where it falls in the trip", () => {
    const saturday = onDay(tripOf(weekend, 1, "milan"), ...afternoon);
    expect(ruleReason(ambrogio, none, "visit", null, saturday)).toBe(
      "It cannot be visited on Sunday, the trip's last day. Rated 4.6 out of 5.",
    );
    const first = onDay(tripOf([SUN, MON, addDays(MON, 1)], 1, "milan"), ...afternoon);
    expect(ruleReason(ambrogio, none, "visit", null, first)).toContain(
      "It cannot be visited on Sunday, the trip's first day.",
    );
    const second = onDay(tripOf([SAT, SUN, MON], 0, "milan"), ...afternoon);
    expect(ruleReason(ambrogio, none, "visit", null, second)).toContain(
      "It cannot be visited on Sunday, the trip's second day.",
    );
  });

  it("says it is the trip's only day when the place is shut on every other one", () => {
    const fridays = makePlace({ hours: makeWeek([5], [{ open: at(9), close: at(19) }]) });
    const text = ruleReason(
      fridays,
      none,
      "visit",
      null,
      onDay(tripOf(weekend, 0), at(11), at(12)),
    );
    expect(text).toBe("The only day of this trip it can be visited. Rated 4.5 out of 5.");
  });

  it("lists the shut days when some other days are open", () => {
    const weekdays = makePlace({
      hours: makeWeek([1, 2, 3, 4, 5], [{ open: at(9), close: at(19) }]),
    });
    const trip = tripOf([FRI, SAT, SUN, MON], 0);
    expect(ruleReason(weekdays, none, "visit", null, onDay(trip, at(11), at(12)))).toContain(
      "It cannot be visited on Saturday or Sunday of this trip.",
    );
  });

  it("says nothing of a day at another base", () => {
    const veniceSunday = tripOf(weekend, 1, "milan", ["milan", "milan", "venice"]);
    const text = ruleReason(ambrogio, none, "visit", null, onDay(veniceSunday, ...afternoon));
    expect(text).not.toContain("cannot be visited");
    // Shut on the Milan Saturday, open on the Venice Sunday: not "the only day".
    const fridays = makePlace({ hours: makeWeek([5], [{ open: at(9), close: at(19) }]) });
    const friday = { ...veniceSunday, index: 0 };
    expect(ruleReason(fridays, none, "visit", null, onDay(friday, at(11), at(12)))).toBe(
      "It cannot be visited on Saturday, the trip's second day. Rated 4.5 out of 5.",
    );
  });

  it("makes no date claim on a day the place is shut, or on a date it cannot read", () => {
    const sunday = onDay(tripOf(weekend, 2, "milan"), ...afternoon);
    expect(ruleReason(ambrogio, none, "visit", null, sunday)).toBe("Rated 4.6 out of 5.");
    const badDate = {
      date: "2026-02-30",
      start: at(10),
      end: at(11),
      trip: tripOf(["2026-02-30"], 0, "milan"),
    };
    expect(ruleReason(ambrogio, none, "visit", null, badDate)).toBe("Rated 4.6 out of 5.");
    const badOther = onDay(tripOf([SAT, "2026-13-01"], 0, "milan"), ...afternoon);
    expect(ruleReason(ambrogio, none, "visit", null, badOther)).not.toContain("cannot be visited");
  });

  it("says nothing about the date without one", () => {
    const text = ruleReason(ambrogio, none, "visit", null, { start: at(10), end: at(11) });
    expect(text).toBe("Rated 4.6 out of 5.");
  });
});

describe("ruleReason when the listing says more than the planner's hours", () => {
  const DATE_WORDS = /visited|Starts|opens/;

  it("says nothing about the Vatican Museums' Sundays: the last one of the month is open", () => {
    // "Closed Sundays except last Sunday of the month" is recorded, not applied: the planner
    // keeps them shut every Sunday, which on 25 October 2026 the listing contradicts.
    const vatican = realPlace("place_010");
    expect(vatican.issues.map((issue) => issue.kind)).toContain("note_not_applied");
    const lastSunday = ["2026-10-24", "2026-10-25", "2026-10-26"]; // the month's last Sunday
    const ordinary = weekendOf(FRI); // Sunday the 11th
    const trips = [tripOf(lastSunday, 0), tripOf(lastSunday, 2), tripOf(ordinary, 1)];
    for (const trip of trips) {
      const text = ruleReason(vatican, none, "visit", null, onDay(trip, at(9), at(13)));
      expect(text).not.toMatch(DATE_WORDS);
      expect(text).toBe("Listed as iconic. Rated 4.7 out of 5.");
    }
  });

  it("says nothing about the Brera market's dates: its third weekend has two readings", () => {
    // Read as days 15 to 21, so Sunday 22 November is shut, though the weekend of the third
    // Saturday runs to it.
    const brera = realPlace("place_059");
    expect(brera.issues.map((issue) => issue.kind)).toContain("hours_conflict");
    const trip = tripOf(["2026-11-21", "2026-11-22", "2026-11-23"], 0, "milan");
    const text = ruleReason(brera, none, "visit", null, onDay(trip, at(9, 40), at(11, 10)));
    expect(text).not.toMatch(DATE_WORDS);
  });

  it("says nothing about the date for a note it could not read", () => {
    const unread: DataIssue = {
      placeId: "place_test",
      field: "seasonal_notes",
      kind: "note_unread",
      raw: null,
      detail: "Note may restrict the dates but was not understood",
      action: "Not applied",
    };
    const fridays = makePlace({
      hours: makeWeek([5], [{ open: at(9), close: at(19) }]),
      issues: [unread],
    });
    const text = ruleReason(
      fridays,
      none,
      "visit",
      null,
      onDay(tripOf(weekendOf(FRI), 0), at(9), at(10)),
    );
    expect(text).toBe("Rated 4.5 out of 5.");
  });
});

describe("ruleReason on a holiday", () => {
  const christmas = ["2026-12-24", "2026-12-25", "2026-12-26"];

  it("claims no opening for a museum or ticketed site on 25 December or 1 January", () => {
    const doges = realPlace("place_067"); // Doge's Palace, listed hours, opens at 09:00
    for (const date of ["2026-12-25", "2027-01-01"]) {
      const text = ruleReason(doges, none, "visit", null, onDay(tripOf([date], 0), at(9), at(11)));
      expect(text).toBe("Listed as iconic. Rated 4.7 out of 5.");
    }
    const boxingDay = onDay(tripOf(["2026-12-26"], 0), at(9), at(11));
    expect(ruleReason(doges, none, "visit", null, boxingDay)).toContain("Starts as it opens.");
    const ambrogio = realPlace("place_098"); // a historic site that reopens at 14:30
    const reopens = onDay(tripOf(christmas, 1, "milan"), at(14, 30), at(15, 30));
    expect(ruleReason(ambrogio, none, "visit", null, reopens)).toBe("Rated 4.6 out of 5.");
  });

  it("never calls a holiday the only day of the trip a museum can be visited", () => {
    const fridays = makePlace({ hours: makeWeek([5], [{ open: at(9), close: at(19) }]) });
    const trip = tripOf(christmas, 1); // Friday 25 December between two days it is shut
    expect(ruleReason(fridays, none, "visit", null, onDay(trip, at(11), at(12)))).toBe(
      "Rated 4.5 out of 5.",
    );
  });

  it("says nothing of the date on a holiday for any place: a trattoria, a market, a class", () => {
    // The data has no holiday hours, so an opening on 25 December or 1 January is unproven for a
    // restaurant as much as for a museum, though only museums and sites are kept off the day.
    const daEnzo = realPlace("place_003"); // reopens at 19:30
    const books = realPlace("place_024"); // the book market, from 09:00, shut on Sundays
    const cooking = realPlace("place_087"); // the Bologna cooking class, from 09:00
    for (const date of ["2026-12-25", "2027-01-01"]) {
      const trip = tripOf([date, addDays(date, 1), addDays(date, 2)], 0);
      const dinner = ruleReason(daEnzo, none, "dinner", null, onDay(trip, at(19, 30), at(21)));
      const market = ruleReason(books, none, "visit", null, onDay(trip, at(9), at(9, 45)));
      const bologna = tripOf([date], 0, "bologna");
      const lesson = ruleReason(cooking, none, "visit", null, onDay(bologna, at(9), at(12, 30)));
      for (const text of [dinner, market, lesson]) {
        expect(text).not.toMatch(/visited|Starts|opens/);
      }
    }
    // The day after, the same dinner says it again.
    const boxingDay = onDay(tripOf(["2026-12-26"], 0), at(19, 30), at(21));
    expect(ruleReason(daEnzo, none, "dinner", null, boxingDay)).toContain("Starts as it reopens.");
  });

  it("never calls a holiday the only day a restaurant can be visited", () => {
    // Trattoria da Cesare is shut on Sundays: 25 December 2027 is a Saturday before one.
    const cesare = realPlace("place_042");
    const trip = tripOf(["2027-12-25", "2027-12-26"], 0);
    const text = ruleReason(cesare, none, "lunch", null, onDay(trip, at(13, 20), at(14, 50)));
    expect(text).not.toMatch(/visited|Starts|opens/);
  });
});

describe("ruleReason when the listing leaves the dates to the traveler", () => {
  const DATE_WORDS = /visited|Starts|opens/;

  it("says nothing of the date for the risotto festival: October is when it runs, not the days", () => {
    const festival = realPlace("place_090"); // "October only, check exact festival dates ..."
    expect(festival.dateRules.map((rule) => rule.kind)).toEqual(["season"]);
    // 1 October after two September days: the planner's season makes it the only day.
    const first = tripOf(["2026-09-29", "2026-09-30", "2026-10-01"], 2, "bologna");
    const last = tripOf(["2026-10-31", "2026-11-01", "2026-11-02"], 0, "bologna");
    for (const trip of [first, last]) {
      const text = ruleReason(festival, none, "visit", null, onDay(trip, at(10, 20), at(15, 20)));
      expect(text).not.toMatch(DATE_WORDS);
    }
  });

  it("reads the note's words, not the place: any note that says to check the dates", () => {
    const fridays = (seasonalNote: string | null) =>
      makePlace({ hours: makeWeek([5], [{ open: at(9), close: at(19) }]), seasonalNote });
    const trip = tripOf(weekendOf(FRI), 0);
    const day = onDay(trip, at(9), at(10));
    for (const note of [
      "Check dates before you go.",
      "Dates vary each year.",
      "Confirm the date.",
    ]) {
      expect(ruleReason(fridays(note), none, "visit", null, day), note).toBe("Rated 4.5 out of 5.");
    }
    expect(ruleReason(fridays("Best in spring."), none, "visit", null, day)).toContain(
      "The only day of this trip it can be visited.",
    );
  });

  it("still names the days a season shuts when the season is the listing's whole answer", () => {
    // Bellagio is "Open April-October only": 1 and 2 November are shut, and the note says so.
    const bellagio = realPlace("place_063");
    const trip = tripOf(["2026-10-31", "2026-11-01", "2026-11-02"], 0, "milan");
    const text = ruleReason(bellagio, none, "visit", null, onDay(trip, at(11), at(17)));
    expect(text).toContain("The only day of this trip it can be visited.");
  });
});

/** Friday, Saturday and Sunday from `friday`. */
function weekendOf(friday: string): string[] {
  return [friday, addDays(friday, 1), addDays(friday, 2)];
}

describe("ruleReason about the stop's hours that day", () => {
  const plain = makePlace({ tags: [], rating: null }); // 09:00 to 19:00 every day, listed
  const monday = tripOf([MON], 0);

  it("says a stop starts as its place opens, and as it reopens for a later range", () => {
    expect(ruleReason(plain, none, "visit", null, onDay(monday, at(9), at(10)))).toBe(
      "Starts as it opens.",
    );
    const daEnzo = realPlace("place_003"); // 12:30 to 14:30 and 19:30 to 22:30, not Sundays
    expect(ruleReason(daEnzo, none, "dinner", null, onDay(monday, at(19, 30), at(21)))).toBe(
      "Starts as it reopens. Listed as a local favorite. Rated 4.6 out of 5.",
    );
    expect(ruleReason(daEnzo, none, "lunch", null, onDay(monday, at(12, 30), at(14)))).toContain(
      "Starts as it opens.",
    );
  });

  it(`says a visit starts soon after it opens up to ${SOON_AFTER_OPENING_MIN} minutes, and no later`, () => {
    const soon = at(9) + SOON_AFTER_OPENING_MIN;
    expect(ruleReason(plain, none, "visit", null, onDay(monday, soon, soon + 60))).toBe(
      "Starts soon after it opens.",
    );
    expect(ruleReason(plain, none, "visit", null, onDay(monday, soon + 1, soon + 61))).toBe(
      "Suggested stop.",
    );
    const twoRanges = makePlace({
      tags: [],
      rating: null,
      hours: makeWeek(
        [1],
        [
          { open: at(10), close: at(12) },
          { open: at(14, 30), close: at(18) },
        ],
      ),
    });
    expect(ruleReason(twoRanges, none, "visit", null, onDay(monday, at(15), at(16)))).toBe(
      "Starts soon after it reopens.",
    );
  });

  it("never calls a meal soon after opening: only a meal that starts as it opens is said", () => {
    const restaurant = makePlace({ tags: [], rating: null, mealCapable: true, meals: ["lunch"] });
    const lunch = ruleReason(restaurant, none, "lunch", null, onDay(monday, at(9, 30), at(10)));
    expect(lunch).toBe("Lunch stop.");
  });

  it("never speaks of opening for estimated hours, a public space, or a visit outside the hours", () => {
    const campo = realPlace("place_006"); // hours estimated as 07:00 to 13:00
    const trevi = realPlace("place_018"); // a public space, planned 07:00 to 23:00
    for (const place of [campo, trevi]) {
      const text = ruleReason(place, none, "visit", null, onDay(monday, at(7), at(8)));
      expect(text).not.toMatch(/Starts|opens/);
    }
    const late = ruleReason(plain, none, "visit", null, onDay(monday, at(18, 30), at(19, 30)));
    expect(late).toBe("Suggested stop.");
  });

  it("says a place opens later on the stop's weekday than on every other day it opens", () => {
    const santaCroce = realPlace("place_036"); // Sundays from 14:00, other days from 09:30
    const sunday = onDay(tripOf([SUN], 0), at(14), at(15, 15));
    expect(ruleReason(santaCroce, none, "visit", null, sunday)).toBe(
      "It opens later on Sunday than on other days. Starts as it opens. Listed as iconic. Rated 4.6 out of 5.",
    );
    const mondayVisit = ruleReason(
      santaCroce,
      none,
      "visit",
      null,
      onDay(monday, at(9, 30), at(11)),
    );
    expect(mondayVisit).not.toContain("opens later");
    // Later than some other days is not later than all of them.
    const stepped = makePlace({
      hours: {
        ...makeWeek([0, 1, 2, 3, 4, 5, 6], [{ open: at(9), close: at(19) }]),
        1: [{ open: at(10), close: at(19) }],
        2: [{ open: at(10), close: at(19) }],
      },
    });
    expect(ruleReason(stepped, none, "visit", null, onDay(monday, at(10), at(11)))).not.toContain(
      "opens later",
    );
    const onlyMondays = makePlace({ hours: makeWeek([1], [{ open: at(14), close: at(19) }]) });
    expect(
      ruleReason(onlyMondays, none, "visit", null, onDay(monday, at(14), at(15))),
    ).not.toContain("opens later");
  });
});

describe("ruleReason about the time of day and the rest of the day", () => {
  const monday = tripOf([MON], 0);
  const tagged = (tags: string[]) => makePlace({ tags, rating: null });

  it(`names a morning tag only when at least half the visit is before ${MORNING_ENDS / 60}:00`, () => {
    const morning = tagged(["morning"]);
    const said = "The listing calls it a morning place.";
    // Half before noon, half after: the midpoint is noon.
    const half = onDay(monday, MORNING_ENDS - 60, MORNING_ENDS + 60);
    expect(ruleReason(morning, none, "visit", null, half)).toBe(said);
    const lessThanHalf = onDay(monday, MORNING_ENDS - 58, MORNING_ENDS + 62);
    expect(ruleReason(morning, none, "visit", null, lessThanHalf)).toBe("Suggested stop.");
    // A market from 11:55 to 13:25 is mostly after noon.
    const late = onDay(monday, MORNING_ENDS - 5, MORNING_ENDS + 85);
    expect(ruleReason(morning, none, "visit", null, late)).not.toContain("morning");
  });

  it(`names an evening tag only when at least half the visit is after ${EVENING_STARTS / 60}:00`, () => {
    const evening = tagged(["evening"]);
    const said = "The listing calls it an evening place.";
    const half = onDay(monday, EVENING_STARTS - 60, EVENING_STARTS + 60);
    expect(ruleReason(evening, none, "visit", null, half)).toBe(said);
    const lessThanHalf = onDay(monday, EVENING_STARTS - 62, EVENING_STARTS + 58);
    expect(ruleReason(evening, none, "visit", null, lessThanHalf)).toBe("Suggested stop.");
    // Trastevere from 15:15 to 18:15 is an afternoon that ends in the evening.
    const trastevere = onDay(monday, at(15, 15), at(18, 15));
    expect(ruleReason(evening, none, "visit", null, trastevere)).toBe("Suggested stop.");
    // Every dinner is in the evening: for a meal the tag says nothing.
    const dinner = ruleReason(evening, none, "dinner", null, onDay(monday, at(19), at(20)));
    expect(dinner).toBe("Dinner stop.");
  });

  it("says the time of day as the listing's words, apart from and after the score's sentences", () => {
    const place = makePlace({ tags: ["iconic", "local-favorite", "evening"], rating: 4.5 });
    const day = { start: at(18), end: at(19), highestRated: true };
    expect(ruleReason(place, none, "visit", null, day)).toBe(
      "Listed as iconic and a local favorite. The day's highest-rated stop. Rated 4.5 out of 5. The listing calls it an evening place.",
    );
  });

  it("says a stop is the day's highest-rated after the listing and before the rating", () => {
    const text = ruleReason(realPlace("place_026"), none, "visit", null, {
      start: at(10),
      end: at(12),
      highestRated: true,
    });
    expect(text).toBe("Listed as iconic. The day's highest-rated stop. Rated 4.8 out of 5.");
  });

  it("puts an outing's meal last, where the board drops it for the row's own label", () => {
    // The Parma tour runs on weekdays only: on a Friday before a weekend it is the only day.
    const parma = realPlace("place_053");
    const day = onDay(tripOf([FRI, SAT, SUN], 0, "bologna"), at(11, 45), at(17, 45));
    expect(ruleReason(parma, none, "visit", null, { ...day, seated: [] })).toBe(
      "The only day of this trip it can be visited. Listed as a local favorite. Rated 4.7 out of 5. Lunch is part of this outing.",
    );
    // When the line is full the meal gives way: the board labels the row "Lunch during this
    // visit" and keeps every other sentence; the swap sheet goes without it.
    const food = { interests: ["food"], mustInclude: [] };
    expect(ruleReason(parma, food, "visit", null, { ...day, seated: [] })).toBe(
      "Matches your interest in food. The only day of this trip it can be visited. Listed as a local favorite. Rated 4.7 out of 5.",
    );
    // A day with a lunch stop, or a day whose meals are not known, says nothing about lunch.
    const seated = ruleReason(parma, none, "visit", null, { ...day, seated: ["lunch"] });
    expect(seated).not.toContain("Lunch");
    expect(ruleReason(parma, none, "visit", null, day)).not.toContain("Lunch");
  });
});

describe("isHighestRated", () => {
  it.each([
    [[4.5, 4.9, 4.7], 1, true],
    [[4.5, 4.9, 4.7], 2, false],
    [[4.9, 4.9], 0, false], // a tie is nobody's
    [[4.5, null, undefined], 0, true], // no rating ranks below every rating
    [[null, 4.5], 0, false],
    [[4.9], 0, false], // a day of one stop has no highest
    [[Number.NaN, 4], 1, true],
    [[Number.POSITIVE_INFINITY, 4], 0, false],
  ])("ratings %j at %i: %s", (ratings, index, expected) => {
    expect(isHighestRated(ratings, index)).toBe(expected);
  });
});

/** Each date sentence of a real plan checked against the planner's own hours answers. */
function checkDateClaims(itinerary: Itinerary): number {
  const ctx = realContext();
  let claims = 0;
  itinerary.days.forEach((day, dayIndex) => {
    const places = day.stops.map((stop) => ctx.placesById.get(stop.placeId) as Place);
    day.stops.forEach((stop, index) => {
      const place = places[index] as Place;
      const text = stop.reason ?? "";
      const status = openStatusOn(place, day.date);
      const ranges = status.state === "open" ? status.ranges : [];
      const others = itinerary.days.filter((_, i) => i !== dayIndex);
      const shut = (date: string) => openStatusOn(place, date).state === "closed";
      const named = text.match(/cannot be visited on (\w+)(?: or (\w+))?/);
      if (named) {
        claims++;
        for (const name of named.slice(1).filter(Boolean)) {
          const match = others.find((other) => weekdayName(other.date) === name);
          expect(match?.anchorId).toBe(day.anchorId);
          expect(shut(match?.date as string)).toBe(true);
        }
      }
      if (text.includes("The only day of this trip")) {
        claims++;
        for (const other of others) {
          expect(other.anchorId).toBe(day.anchorId);
          expect(shut(other.date)).toBe(true);
        }
      }
      const starts = text.match(/Starts (as|soon after) it (opens|reopens)\./);
      if (starts) {
        claims++;
        const range = ranges.find((r) => r.open <= stop.start && stop.end <= r.close);
        expect(place.hoursConfidence).toBe("listed");
        expect(range).toBeDefined();
        expect(ranges.indexOf(range as (typeof ranges)[number]) > 0).toBe(starts[2] === "reopens");
        const after = stop.start - (range?.open ?? Number.NaN);
        if (starts[1] === "as") expect(after).toBe(0);
        else
          expect(after > 0 && after <= SOON_AFTER_OPENING_MIN && stop.role === "visit").toBe(true);
      }
      if (text.includes("opens later on")) {
        claims++;
        const first = ranges[0]?.open ?? Number.NaN;
        for (let offset = 1; offset < 7; offset++) {
          const other = openStatusOn(place, addDays(day.date, offset));
          if (other.state === "open") expect(other.ranges[0]?.open).toBeLessThan(first);
        }
      }
      if (text.includes("The listing calls it a morning place.")) {
        claims++;
        expect(place.tags).toContain("morning");
        expect(stop.role).toBe("visit");
        expect(stop.start + stop.end).toBeLessThanOrEqual(2 * MORNING_ENDS); // half or more before
      }
      if (text.includes("The listing calls it an evening place.")) {
        claims++;
        expect(place.tags).toContain("evening");
        expect(stop.role).toBe("visit");
        expect(stop.start + stop.end).toBeGreaterThanOrEqual(2 * EVENING_STARTS); // half or more after
      }
      if (unsettled(place) || datesToCheck(place) || isHoliday(day.date)) {
        expect(text).not.toMatch(/visited|Starts|opens/);
      }
      if (text.includes("The day's highest-rated stop.")) {
        claims++;
        for (const other of places) {
          if (other !== place) expect(other.rating ?? -1).toBeLessThan(place.rating as number);
        }
      }
    });
  });
  return claims;
}

function weekdayName(date: string): string {
  return WEEKDAY_LONG[weekdayOf(date)];
}

/** A note the planner recorded but did not apply, or read over the listed hours. */
function unsettled(place: Place): boolean {
  const kinds = ["note_not_applied", "note_unread", "hours_conflict"];
  return place.issues.some((issue) => kinds.includes(issue.kind));
}

/** A note that tells the traveler to check the dates. */
function datesToCheck(place: Place): boolean {
  return /\bcheck\b.*\bdates?\b/i.test(place.seasonalNote ?? "");
}

describe("rule reasons on real trips", () => {
  const ctx = realContext();
  it("says something about their day for two in five visits of a week of default trips, all of it true", () => {
    // The page's default request (balanced, nothing else chosen) on each start date of a week from
    // two weeks after 2026-09-25. Measured over a week, not one trip, so a planner change that
    // swaps one visit does not move the bar (43 of 97 visits when written). Two stops may share a
    // line (no day-level dedupe, reasons.ts); what each line says must hold.
    let visits = 0;
    let dated = 0;
    let claims = 0;
    for (let offset = 0; offset < 7; offset++) {
      const startDate = addDays(FRI, offset);
      const plan = planDeterministic(makeRequest({ startDate }), ctx);
      claims += checkDateClaims(plan);
      for (const day of plan.days) {
        for (const stop of day.stops.filter((s) => s.role === "visit")) {
          visits++;
          if (
            /cannot be visited|only day|Starts|opens later|place\.|highest-rated/.test(
              stop.reason ?? "",
            )
          ) {
            dated++;
          }
        }
      }
    }
    expect(dated / visits).toBeGreaterThanOrEqual(0.4);
    expect(claims).toBeGreaterThan(30);
  });

  it("says only what the planner's hours answers confirm, on trips across bases and dates", () => {
    let claims = 0;
    for (const anchors of [["rome"], ["florence"], ["venice"], ["milan"], ["bologna"]]) {
      // 23 October 2026 runs to the month's last Sunday; 24 December to Christmas Day.
      for (const startDate of [FRI, "2026-10-23", "2026-12-24", "2026-12-26", "2027-04-17"]) {
        for (const pace of ["relaxed", "packed"] as const) {
          const request = makeRequest({ anchors, startDate, pace, interests: ["food", "art"] });
          claims += checkDateClaims(planDeterministic(request, ctx));
        }
      }
    }
    expect(claims).toBeGreaterThan(100);
  });
});

describe("ruleReason on hostile data", () => {
  const text = fc.string({ maxLength: 400, unit: "binary" });

  it("never exceeds the length limit, never comes back empty, and strips control characters", () => {
    fc.assert(
      fc.property(
        text,
        fc.option(text, { nil: null }),
        fc.array(text, { maxLength: 6 }),
        fc.option(fc.double({ min: 0, max: 5, noNaN: true }), { nil: null }),
        fc.constantFrom(...ROLES),
        (city, neighborhood, tags, rating, role) => {
          const place = makePlace({ city, neighborhood, tags, rating });
          const reason = ruleReason(
            place,
            { interests: tags, mustInclude: [place.id] },
            role,
            place,
          );
          expect(reason.length).toBeGreaterThan(0);
          expect(reason.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
          expect(reason).not.toMatch(/[\p{Cc}\p{Cf}]/u);
          expect(reason).toBe(reason.trim());
        },
      ),
      FC_SETTINGS,
    );
  });

  it("never throws on any date, time or trip, and makes no date claim it cannot read", () => {
    const date = fc.oneof(fc.constantFrom(FRI, SAT, SUN, MON, "2026-02-30"), fc.string());
    const minute = fc.oneof(fc.integer({ min: -60, max: 1800 }), fc.constant(Number.NaN));
    fc.assert(
      fc.property(
        date,
        minute,
        minute,
        fc.array(fc.record({ date, anchorId: fc.constantFrom("milan", "venice") }), {
          maxLength: 5,
        }),
        fc.nat({ max: 6 }),
        fc.constantFrom(...ROLES),
        (day, start, end, days, index, role) => {
          const place = realPlace("place_098"); // shut on Sundays, two ranges a day
          const trip = { days, index };
          const reason = ruleReason(place, none, role, null, { date: day, start, end, trip });
          expect(reason.length).toBeGreaterThan(0);
          expect(reason.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) expect(reason).not.toMatch(/visited|Starts|opens/);
        },
      ),
      FC_SETTINGS,
    );
  });

  it("skips an over-long interest sentence rather than cutting a word in half", () => {
    const tag = "n".repeat(200);
    const request = { interests: [tag], mustInclude: [] };
    expect(ruleReason(makePlace({ tags: [tag], rating: 4 }), request, "visit")).toBe(
      "Rated 4 out of 5.",
    );
    expect(ruleReason(makePlace({ tags: [tag], rating: null }), request, "lunch")).toBe(
      "Lunch stop.",
    );
  });
});
