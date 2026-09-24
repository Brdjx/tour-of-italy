import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MEALS } from "../src/config";
import {
  earliestMealStart,
  earliestOpenStart,
  isOpenDuring,
  mealWindowAllows,
} from "../src/constraints";
import { addDays, hoursOn, weekdayOf } from "../src/time";
import { FC_SETTINGS, makePlace, realContext, realPlace } from "./plannerFixtures";

// Failure vector F1 (closed place) and F7 (date bugs): isOpenDuring is the only answer the
// scheduler and the validator use for "can this visit happen then". Every case uses a real place
// and a real date, so a regression in the data or the rule shows up here.

const TUESDAY = "2026-10-20";
const MONDAY = "2026-10-19";
const SUNDAY = "2026-10-25";

describe("isOpenDuring on real places", () => {
  it("never opens a Tues-Sun museum (Borghese) on its closed Monday", () => {
    expect(weekdayOf(MONDAY)).toBe(1);
    expect(isOpenDuring(realPlace("place_007"), MONDAY, 600, 720)).toBe("no");
    expect(isOpenDuring(realPlace("place_007"), TUESDAY, 600, 720)).toBe("yes");
  });

  // Da Enzo al 29: Mon-Sat 12:30-14:30 and 19:30-22:30.
  it.each([
    [750, 870, "yes"], // starts at opening, ends at closing: both ends inclusive
    [749, 839, "no"], // a minute before opening
    [800, 871, "no"], // a minute past the lunch close
    [840, 1200, "no"], // spans the afternoon break
    [1170, 1260, "yes"], // dinner service
  ])(
    "checks a split-hours visit %s to %s as %s, never across the midday break",
    (start, end, answer) => {
      expect(isOpenDuring(realPlace("place_003"), TUESDAY, start, end)).toBe(answer);
    },
  );

  it("keeps Da Enzo closed on Sunday, the day its Mon-Sat hours leave out", () => {
    expect(weekdayOf(SUNDAY)).toBe(0);
    expect(isOpenDuring(realPlace("place_003"), SUNDAY, 1170, 1260)).toBe("no");
  });

  // Il Sorpasso: 8:00-01:00, stored as 480 to 1500.
  it.each([
    [1410, 1470, "yes"], // 23:30 to 00:30
    [1440, 1500, "yes"], // midnight to the 01:00 close
    [1450, 1510, "no"], // runs past the 01:00 close
  ])("reads a past-midnight close correctly for %s to %s (%s)", (start, end, answer) => {
    expect(isOpenDuring(realPlace("place_020"), TUESDAY, start, end)).toBe(answer);
  });

  // Villa del Balbianello: Tue, Thu-Sun 10:00-18:00, open April to October only.
  it.each([
    ["2027-01-16", "no"], // a Saturday in winter
    ["2028-02-29", "no"], // leap day, a Tuesday, out of season
    ["2026-04-02", "yes"], // first Thursday of the season
    ["2026-10-31", "yes"], // last day of the season, a Saturday
    ["2026-11-01", "no"], // first day after the season, a Sunday
    ["2026-04-01", "no"], // in season but a Wednesday, its closed day
  ])("applies the April-October season and weekly hours on %s (%s)", (date, answer) => {
    expect(isOpenDuring(realPlace("place_064"), date, 600, 720)).toBe(answer);
  });

  it("keeps a seasonal place with unknown hours (Bellagio) closed in winter, unknown in summer", () => {
    expect(isOpenDuring(realPlace("place_063"), "2027-01-16", 600, 960)).toBe("no");
    expect(isOpenDuring(realPlace("place_063"), "2026-06-13", 600, 960)).toBe("unknown");
  });

  it.each([
    [600, 630, "no"], // Trevi by Night at 10:00
    [1260, 1290, "yes"], // 21:00
    [1410, 1440, "yes"], // ends at midnight
    [1425, 1455, "no"], // runs past its derived window
  ])("holds a derived night window: Trevi by Night %s to %s is %s", (start, end, answer) => {
    expect(isOpenDuring(realPlace("place_077"), TUESDAY, start, end)).toBe(answer);
  });

  it("holds a derived early-morning window (Cannaregio 06:00 to 11:00) against a late start", () => {
    expect(isOpenDuring(realPlace("place_075"), TUESDAY, 510, 600)).toBe("yes");
    expect(isOpenDuring(realPlace("place_075"), TUESDAY, 570, 660)).toBe("yes");
    expect(isOpenDuring(realPlace("place_075"), TUESDAY, 600, 690)).toBe("no");
  });

  it("holds a derived dawn window (Piazza del Popolo 06:00 to 10:00) against a late start", () => {
    expect(isOpenDuring(realPlace("place_023"), TUESDAY, 540, 570)).toBe("yes");
    expect(isOpenDuring(realPlace("place_023"), TUESDAY, 580, 610)).toBe("no");
  });

  it("closes an open-access square (Piazza Navona) at 23:00", () => {
    expect(isOpenDuring(realPlace("place_008"), TUESDAY, 1320, 1365)).toBe("yes");
    expect(isOpenDuring(realPlace("place_008"), TUESDAY, 1350, 1395)).toBe("no");
  });

  it("says unknown, not yes, for a place with no hours (Appian Way bike ride)", () => {
    expect(isOpenDuring(realPlace("place_021"), TUESDAY, 600, 840)).toBe("unknown");
  });

  it.each([
    ["2026-10-17", "yes"], // third Saturday
    ["2026-10-18", "yes"], // third Sunday
    ["2026-10-10", "no"], // second Saturday
    ["2026-10-24", "no"], // fourth Saturday
  ])("opens the Brera market only on its third weekend: %s is %s", (date, answer) => {
    expect(isOpenDuring(realPlace("place_059"), date, 600, 690)).toBe(answer);
  });

  it("keeps the weekday-only Parma tour closed on Saturday though its hours are unknown", () => {
    expect(isOpenDuring(realPlace("place_053"), "2026-10-17", 600, 960)).toBe("no");
    expect(isOpenDuring(realPlace("place_053"), MONDAY, 600, 960)).toBe("unknown");
  });

  it.each([
    [600, 600],
    [600, 590],
    [Number.NaN, 600],
    [600, Number.POSITIVE_INFINITY],
  ])("rejects an invalid visit %s to %s as closed, even with unknown hours", (start, end) => {
    expect(isOpenDuring(realPlace("place_001"), TUESDAY, start, end)).toBe("no");
    expect(isOpenDuring(realPlace("place_021"), TUESDAY, start, end)).toBe("no");
  });

  it("throws on an impossible date for every place instead of guessing", () => {
    for (const place of realContext().places) {
      expect(() => isOpenDuring(place, "2026-02-30", 600, 660)).toThrow(RangeError);
    }
  });
});

describe("earliestOpenStart", () => {
  const enzo = () => realPlace("place_003");

  it("waits for opening rather than starting a visit before the doors open", () => {
    expect(earliestOpenStart(enzo(), TUESDAY, 600, 90)).toBe(750);
  });

  it("skips to the evening service when lunch no longer has room for the visit", () => {
    expect(earliestOpenStart(enzo(), TUESDAY, 840, 90)).toBe(1170);
  });

  it("returns null when no range can hold the visit that day", () => {
    expect(earliestOpenStart(enzo(), TUESDAY, 1290, 90)).toBeNull();
    expect(earliestOpenStart(enzo(), SUNDAY, 600, 90)).toBeNull();
  });

  it("never books Osteria Francescana's 2-hour meal into its 90-minute lunch service", () => {
    const francescana = realPlace("place_043");
    expect(francescana.durationMin).toBe(120);
    expect(earliestOpenStart(francescana, TUESDAY, 600, 120)).toBe(1200);
  });

  it("returns the requested time for unknown hours, and null when a date rule closes it", () => {
    expect(earliestOpenStart(realPlace("place_021"), TUESDAY, 610, 240)).toBe(610);
    expect(earliestOpenStart(realPlace("place_063"), "2027-01-16", 610, 240)).toBeNull();
  });

  it.each([0, -30, Number.NaN])("returns null for a %s-minute visit", (duration) => {
    expect(earliestOpenStart(makePlace(), TUESDAY, 600, duration)).toBeNull();
  });
});

describe("hours properties over real places and dates", () => {
  const places = realContext().places;
  const visit = fc.record({
    placeIndex: fc.nat({ max: places.length - 1 }),
    dayOffset: fc.integer({ min: 0, max: 3 * 366 }), // 2026 through 2028, leap day included
    start: fc.integer({ min: 0, max: 1500 }),
    duration: fc.integer({ min: 1, max: 480 }),
  });

  it("answers yes only when one open range covers every minute of the visit", () => {
    fc.assert(
      fc.property(visit, ({ placeIndex, dayOffset, start, duration }) => {
        const place = places[placeIndex];
        if (!place) return;
        const date = addDays("2026-01-01", dayOffset);
        const answer = isOpenDuring(place, date, start, start + duration);
        const ranges = hoursOn(place, date);
        if (ranges === "unknown") {
          expect(answer).toBe("unknown");
          return;
        }
        const covered = ranges.some((r) => r.open <= start && start + duration <= r.close);
        expect(answer).toBe(covered ? "yes" : "no");
      }),
      FC_SETTINGS,
    );
  });

  it("finds the earliest fitting start: it fits, and one minute earlier does not", () => {
    fc.assert(
      fc.property(visit, ({ placeIndex, dayOffset, start, duration }) => {
        const place = places[placeIndex];
        if (!place || place.hours === null) return;
        const date = addDays("2026-01-01", dayOffset);
        const found = earliestOpenStart(place, date, start, duration);
        if (found === null) {
          expect(isOpenDuring(place, date, start, start + duration)).not.toBe("yes");
          return;
        }
        expect(found).toBeGreaterThanOrEqual(start);
        expect(isOpenDuring(place, date, found, found + duration)).toBe("yes");
        if (found > start)
          expect(isOpenDuring(place, date, found - 1, found - 1 + duration)).toBe("no");
      }),
      FC_SETTINGS,
    );
  });

  it("seats a meal only at a start inside its window that the hours allow, and finds one if any exists", () => {
    const meal = fc.constantFrom("lunch" as const, "dinner" as const);
    fc.assert(
      fc.property(visit, meal, ({ placeIndex, dayOffset, start }, which) => {
        const place = places[placeIndex];
        if (!place) return;
        const date = addDays("2026-01-01", dayOffset);
        const found = earliestMealStart(place, date, start, which, place.durationMin);
        if (found !== null) {
          expect(found).toBeGreaterThanOrEqual(start);
          expect(mealWindowAllows(which, found)).toBe(true);
          expect(isOpenDuring(place, date, found, found + place.durationMin)).not.toBe("no");
          return;
        }
        const { earliestStart, latestStart } = MEALS[which];
        for (let t = Math.max(start, earliestStart); t <= latestStart; t++) {
          expect(isOpenDuring(place, date, t, t + place.durationMin)).toBe("no");
        }
      }),
      FC_SETTINGS,
    );
  });
});
