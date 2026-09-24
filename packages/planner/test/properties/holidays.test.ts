import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { PACE } from "../../src/config";
import { repairMustIncludes } from "../../src/mustRepair";
import { planDeterministic } from "../../src/plan";
import { addDays, hoursOn, tripDates } from "../../src/time";
import { travelMinutes } from "../../src/travel";
import { mistimedMustIncludes } from "../../src/tripBuilder";
import type { DayPlan, Pace, Place, TripRequest } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { makeRequest } from "../plannerFixtures";
import { ctx, PACE_VALUES, PROPERTY_SETTINGS, seedLine } from "./arbitraries";

// Most museums and ticketed sites in Italy close on 25 December and 1 January (HOLIDAY_CLOSURES).
// The data has no holiday hours, so the planner keeps them off those dates by preference. The
// failure this prevents: a traveler who asked for the Uffizi is sent there on Christmas Day while
// the next day of the trip has it open, with no warning. The place must still never be dropped.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 40;

/** Museums and historic sites with listed hours: the places the holiday preference covers. */
const ticketed: readonly Place[] = ctx.places.filter(
  (place) =>
    (place.type === "museum" || place.type === "historic_site") &&
    place.hoursConfidence === "listed",
);

const isHoliday = (date: string) => /-12-25$|-01-01$/.test(date);

/** True when the place alone fits a day at its base: hours, window, the way there and back. */
function couldHoldAlone(place: Place, date: string, pace: Pace): boolean {
  const anchor = ctx.anchorById.get(ctx.anchorIdByPlaceId.get(place.id) ?? "");
  if (!anchor) return false;
  const ranges = hoursOn(place, date);
  if (ranges === "unknown") return true;
  const leg = travelMinutes(anchor.centroid, place);
  const earliest = PACE[pace].dayStart + leg;
  const latestEnd = PACE[pace].dayEnd - leg;
  return ranges.some((range) => {
    const start = Math.max(range.open, earliest);
    return start + place.durationMin <= Math.min(range.close, latestEnd);
  });
}

function dayWith(days: readonly DayPlan[], id: string): DayPlan | undefined {
  return days.find((day) => day.stops.some((stop) => stop.placeId === id));
}

/** A trip at the place's own base that starts within three days of a holiday. */
const holidayTrip = fc.record({
  place: fc.constantFrom(...ticketed),
  start: fc.constantFrom("2026-12-23", "2027-12-29", "2028-12-24"),
  shift: fc.integer({ min: 0, max: 3 }),
  pace: fc.constantFrom(...PACE_VALUES),
});

describe("requested museums around 25 December and 1 January", () => {
  beforeAll(() => {
    console.info(seedLine("holidays"));
  });

  it.each([
    ["place_026", "2026-12-25", "balanced", "florence"], // Uffizi, open 26 and 27 December
    ["place_036", "2026-12-23", "packed", "florence"], // Santa Croce, open 23 and 24 December
    ["place_001", "2026-12-25", "balanced", "rome"], // Colosseum, open 26 and 27 December
  ] as const)(
    "never puts requested %s on the holiday of a %s trip when another day has it open",
    (id, startDate, pace, base) => {
      const request = makeRequest({ startDate, pace, anchors: [base], mustInclude: [id] });
      const day = dayWith(planDeterministic(request, ctx).days, id);
      expect(day?.date, "the place must stay in the trip").toBeDefined();
      expect(isHoliday(day?.date ?? ""), `${id} on ${day?.date}`).toBe(false);
    },
  );

  it("never puts the requested Pinacoteca on 1 January when 2 and 3 January have it open", () => {
    const request = makeRequest({
      startDate: "2027-01-01",
      pace: "packed",
      anchors: ["bologna"],
      mustInclude: ["place_076", "place_051"],
    });
    const day = dayWith(planDeterministic(request, ctx).days, "place_051");
    expect(day?.date).toBeDefined();
    expect(day?.date).not.toBe("2027-01-01");
  });

  it("never lets the repair put a requested museum on the holiday first when the next day fits", () => {
    const request = makeRequest({
      startDate: "2026-12-25",
      anchors: ["rome"],
      mustInclude: ["place_001"],
    });
    const dates = tripDates(request.startDate);
    const draft = {
      anchorIds: ["rome", "rome", "rome"],
      days: [["place_018"], ["place_002"], ["place_008"]],
      score: 0,
    };
    const repaired = repairMustIncludes(draft, request, ctx, dates);
    expect(repaired.days[0]).not.toContain("place_001");
    expect(repaired.days[1]).toContain("place_001");
    // An arrangement with the Colosseum on Christmas Day counts it as mistimed, so another wins.
    const onHoliday = { ...draft, days: [["place_001"], ["place_002"], ["place_008"]] };
    expect(mistimedMustIncludes(onHoliday, request, ctx, dates)).toBe(1);
    expect(mistimedMustIncludes(repaired, request, ctx, dates)).toBe(0);
  });

  it(
    "never puts a requested museum on a holiday unless no other trip day could hold it",
    () => {
      fc.assert(
        fc.property(holidayTrip, ({ place, start, shift, pace }) => {
          const base = ctx.anchorIdByPlaceId.get(place.id) ?? "";
          const request: TripRequest = {
            ...makeRequest({ startDate: addDays(start, shift), pace, anchors: [base] }),
            mustInclude: [place.id],
          };
          const itinerary = planDeterministic(request, ctx);
          const errors = validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");
          expect(errors).toEqual([]);
          const holding = itinerary.days.filter((d) => couldHoldAlone(place, d.date, pace));
          const day = dayWith(itinerary.days, place.id);
          if (holding.length > 0) expect(day, `${place.id} dropped`).toBeDefined();
          if (!day || !isHoliday(day.date)) return;
          const other = holding.find((d) => d.date !== day.date && !isHoliday(d.date));
          expect(other?.date, `${place.id} on ${day.date}, open on ${other?.date}`).toBeUndefined();
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );
});
