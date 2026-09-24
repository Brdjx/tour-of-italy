import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { MEALS } from "../../src/config";
import { earliestMealStart, isMealPlace, isOuting, servesMeal } from "../../src/constraints";
import { closedForHoliday, daylightEnd, isPreDinner } from "../../src/dayRules";
import { haversineKm } from "../../src/normalize/geo";
import {
  AFTER_NOON_NAME,
  APERITIVO_EARLIEST_START,
  OUTING_LATEST_START,
  PRE_DINNER_NAME,
  SATELLITE_AREA_KM,
  TREAT_EARLIEST_START,
} from "../../src/planPolicy";
import type { Itinerary, Place, Stop, TripRequest } from "../../src/types";
import { anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { planFor } from "./planMemo";

// The rules-only plan is what a traveler sees whenever the AI is off or fails, and a demo team
// judges it by eye. Hard rules are proven elsewhere; these properties prove the day looks right:
// meal places are meals, day trips leave in the morning, parks close at dusk, nothing but gelato
// follows dinner, and one day never mixes two out-of-town areas. A must-include is exempt from
// the preferences (the traveler asked for it), so each check looks at ordinary stops only.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 50;

interface PlannedStop {
  stop: Stop;
  place: Place;
  date: string;
  anchorName: string;
  index: number;
  day: readonly Stop[];
}

/** Every stop of the plan with its place, date, and day, for the checks below. */
function stopsOf(itinerary: Itinerary): PlannedStop[] {
  const found: PlannedStop[] = [];
  for (const day of itinerary.days) {
    const anchorName = ctx.anchorById.get(day.anchorId)?.name ?? "";
    day.stops.forEach((stop, index) => {
      const place = ctx.placesById.get(stop.placeId);
      if (place) found.push({ stop, place, date: day.date, anchorName, index, day: day.stops });
    });
  }
  return found;
}

/**
 * True for the only visit of its day: a day nothing else could fill borrows or visits one stop
 * (tripRescue.ts), and keeping the base the traveler chose outranks the day's preferences.
 */
function rescuedVisit(stop: Stop, day: readonly Stop[]): boolean {
  return stop.role === "visit" && day.filter((other) => other.role === "visit").length === 1;
}

function ordinary(request: TripRequest, place: Place): boolean {
  return !request.mustInclude.includes(place.id);
}

/** Asserts `check` holds for the plan of every generated request. */
function forEveryPlan(check: (itinerary: Itinerary, request: TripRequest) => void): void {
  fc.assert(
    fc.property(anyTripRequest, (request) => check(planFor(request), request)),
    PROPERTY_SETTINGS,
  );
}

describe("planDeterministic plans a day a traveler would recognize", () => {
  beforeAll(() => {
    console.info(seedLine("planRealism"));
  });

  it(
    "never uses a meal place as a sightseeing visit while it could have been that meal",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place, date, index, day } of stopsOf(itinerary)) {
          if (stop.role !== "visit" || !isMealPlace(place)) continue;
          // An ordinary one only as the lone stop of a day nothing else could fill (tripRescue.ts).
          if (ordinary(request, place)) expect(rescuedVisit(stop, day), `${place.id}`).toBe(true);
          for (const later of day.slice(index + 1)) {
            if (later.role === "visit" || !servesMeal(place, later.role)) continue;
            const window = MEALS[later.role];
            const could = earliestMealStart(
              place,
              date,
              window.earliestStart,
              later.role,
              place.durationMin,
            );
            expect(could, `${place.id} visited, then ${later.role} elsewhere`).toBeNull();
          }
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never starts an ordinary outing (a day trip, a 4-hour visit) after noon",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place } of stopsOf(itinerary)) {
          if (!isOuting(place) || !ordinary(request, place)) continue;
          expect(stop.start, place.id).toBeLessThanOrEqual(OUTING_LATEST_START);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never keeps an ordinary park or outdoor experience going after sunset, or a tasting after 18:00",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place, date } of stopsOf(itinerary)) {
          if (!ordinary(request, place)) continue;
          expect(stop.end, `${place.id} on ${date}`).toBeLessThanOrEqual(daylightEnd(place, date));
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never plans a food hall, an aperitivo, or another meal place after dinner",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place, index, day } of stopsOf(itinerary)) {
          if (stop.role !== "visit" || !isPreDinner(place) || !ordinary(request, place)) continue;
          const dinner = day.findIndex((other) => other.role === "dinner");
          expect(dinner === -1 || index < dinner, `${place.id} after dinner`).toBe(true);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never plans an ordinary aperitivo before 17:00 (Ceresio 7 at lunchtime)",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place, day } of stopsOf(itinerary)) {
          if (stop.role !== "visit" || !PRE_DINNER_NAME.test(place.name)) continue;
          if (!ordinary(request, place) || rescuedVisit(stop, day)) continue;
          expect(stop.start, place.id).toBeGreaterThanOrEqual(APERITIVO_EARLIEST_START);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never sends a traveler to an ordinary museum or ticketed site on 25 December or 1 January",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place, date, day } of stopsOf(itinerary)) {
          if (!ordinary(request, place) || rescuedVisit(stop, day)) continue;
          expect(closedForHoliday(place, date), `${place.id} on ${date}`).toBe(false);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never leaves town twice in one day (Modena, back to Bologna for lunch, then Maranello)",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const day of itinerary.days) {
          const anchorName = ctx.anchorById.get(day.anchorId)?.name ?? "";
          let trips = 0;
          let away = false;
          for (const stop of day.stops) {
            const out = ctx.placesById.get(stop.placeId)?.city !== anchorName;
            // A trip out that starts with a place the traveler asked for is theirs to make.
            if (out && !away && !request.mustInclude.includes(stop.placeId)) trips++;
            away = out;
          }
          expect(trips, `${day.date} leaves ${day.anchorId} ${trips} times`).toBeLessThanOrEqual(1);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never serves an ordinary gelato or wine bar stop before noon",
    () => {
      forEveryPlan((itinerary, request) => {
        for (const { stop, place, day } of stopsOf(itinerary)) {
          if (!AFTER_NOON_NAME.test(place.name) || !ordinary(request, place)) continue;
          if (rescuedVisit(stop, day)) continue;
          expect(stop.start, place.id).toBeGreaterThanOrEqual(TREAT_EARLIEST_START);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never chains two out-of-town areas in one day (Maranello then Isola della Scala)",
    () => {
      forEveryPlan((itinerary, request) => {
        const byDay = new Map<string, PlannedStop[]>();
        for (const planned of stopsOf(itinerary)) {
          if (planned.place.city === planned.anchorName || !ordinary(request, planned.place))
            continue;
          byDay.set(planned.date, [...(byDay.get(planned.date) ?? []), planned]);
        }
        for (const away of byDay.values()) {
          away.forEach((a, i) => {
            for (const b of away.slice(i + 1)) {
              expect(
                haversineKm(a.place, b.place),
                `${a.place.id} and ${b.place.id}`,
              ).toBeLessThanOrEqual(SATELLITE_AREA_KM);
            }
          });
        }
      });
    },
    TIMEOUT_MS,
  );
});
