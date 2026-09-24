import { MEALS } from "./config";
import { isMealPlace, isOuting, servesMeal } from "./constraints";
import type { LatestStarts } from "./dayLimits";
import {
  AFTER_NOON_NAME,
  APERITIVO_EARLIEST_START,
  DAYTIME_LATEST_END,
  DAYTIME_NAME,
  HOLIDAY_CLOSURES,
  LEAVE_TOWN_BY,
  OUTING_LATEST_START,
  PRE_DINNER_NAME,
  SATELLITE_AREA_KM,
  SUNSET_BY_MONTH,
  TREAT_EARLIEST_START,
} from "./planPolicy";
import { monthDayOf } from "./time";
import { haversineKm } from "./travel";
import type { Anchor, Meal, Place, Stop, StopRole } from "./types";

// The rules-only planner's preferences for a day that looks right to a traveler, on top of the
// hard rules every plan must keep. The validator never checks these: an AI plan or an edit that
// breaks one is still valid, only less natural. Time limits (outings by noon, parks by sunset)
// are folded into the latest starts in dayLimits.ts; the rules here depend on the day so far.

/** Parks and outdoor experiences (bike rides, day trips) are planned in daylight. */
export function needsDaylight(place: Pick<Place, "type" | "tags">): boolean {
  return place.type === "park" || (place.type === "experience" && place.tags.includes("outdoors"));
}

/**
 * The latest end the planner prefers for the place on the date: sunset for a daylight place,
 * DAYTIME_LATEST_END for a tasting with no listed hours, else no limit.
 */
export function daylightEnd(
  place: Pick<Place, "type" | "tags" | "name" | "hoursConfidence">,
  date: string,
): number {
  let end = Number.POSITIVE_INFINITY;
  if (needsDaylight(place)) end = SUNSET_BY_MONTH[monthDayOf(date).month - 1] ?? end;
  if (place.hoursConfidence === "unknown" && DAYTIME_NAME.test(place.name)) {
    end = Math.min(end, DAYTIME_LATEST_END);
  }
  return end;
}

/** True for a museum or ticketed historic site on a date most of them close (HOLIDAY_CLOSURES). */
export function closedForHoliday(
  place: Pick<Place, "type" | "hoursConfidence">,
  date: string,
): boolean {
  const ticketed = place.type === "museum" || place.type === "historic_site";
  if (!ticketed || place.hoursConfidence !== "listed") return false;
  const { month, day } = monthDayOf(date);
  return HOLIDAY_CLOSURES.some((holiday) => holiday.month === month && holiday.day === day);
}

/** A stop that belongs before dinner: a meal place, or an aperitivo. */
// Decision: gelato after dinner is fine (a cafe, not a meal place); a food hall, Eataly, or an
// aperitivo after dinner is not something a traveler would plan.
export function isPreDinner(place: Pick<Place, "mealCapable" | "name">): boolean {
  return isMealPlace(place) || PRE_DINNER_NAME.test(place.name);
}

/**
 * True when a place outside the base city fits with the other out-of-town stops of the day:
 * within SATELLITE_AREA_KM of each. A place in the base city always fits.
 */
// Decision: one area per day, not one town. Modena then Maranello is one outing; Maranello then
// Isola della Scala (83 km, another direction) is two, and the second waits for another day.
export function inSatelliteArea(
  place: Place,
  today: readonly Place[],
  anchor: Pick<Anchor, "name">,
): boolean {
  if (place.city === anchor.name) return true;
  return today.every(
    (other) => other.city === anchor.name || haversineKm(other, place) <= SATELLITE_AREA_KM,
  );
}

/** What the day rules need to know about the day so far. */
export interface DaySoFar {
  mealVisits: boolean; // a rescued day: a meal place may be a visit whatever meals are left
  clock: number; // when the previous stop ends (or the day starts): when the traveler leaves
  mealsTaken: readonly Meal[];
  today: readonly Place[]; // places already planned today, in order
  anchor: Pick<Anchor, "name">;
}

/** A candidate next stop: the place, its role and times, and whether the traveler asked for it. */
export interface NextStop {
  place: Place;
  role: StopRole;
  arrive: number;
  start: number;
  travelMin: number; // from the previous stop, or from the day's start point
  obligation: boolean;
  latest: LatestStarts | undefined; // the place's latest starts today (dayLimits.ts)
}

/**
 * True when the walk may take this stop next. A must-include meal place is a visit only once no
 * meal it serves can still happen today. Ordinary places also never follow dinner as a
 * pre-dinner stop, and keep out-of-town trips sensible (outOfTownAllowed).
 */
export function keepsDayRules(next: NextStop, day: DaySoFar): boolean {
  const { place, role } = next;
  // A rescued day lifts the meal gate for ordinary places only: a must-include stays a meal.
  const gated = !day.mealVisits || next.obligation;
  const mealVisit = role === "visit" && isMealPlace(place) && gated;
  if (mealVisit && mealStillPossible(next, day.mealsTaken)) return false;
  if (next.obligation) return true; // the traveler asked for it: only the meal rule applies
  if (role === "visit" && day.mealsTaken.includes("dinner") && isPreDinner(place)) return false;
  // Decision: gelato is an afternoon or evening treat; "Gelato at Giolitti, 08:40" was the first
  // stop of too many Rome days (it is tagged iconic and opens at 07:30). It also comes after
  // lunch, not before it: until lunch is taken or its last start has passed, no treat.
  if (AFTER_NOON_NAME.test(place.name) && next.start < TREAT_EARLIEST_START) return false;
  if (AFTER_NOON_NAME.test(place.name) && beforeLunch(next.start, day.mealsTaken)) return false;
  if (role === "visit" && isEarlyAperitivo(place, next.start)) return false;
  return outOfTownAllowed(next, day);
}

/**
 * True for a stop in the base city, or an out-of-town stop that fits the day's trip out: right
 * after another out-of-town stop and in the same area as all of them, or, when it is the first,
 * a visit left for by LEAVE_TOWN_BY that lasts at least as long as the trip there. A meal out of
 * town only once the day is already in that area.
 */
// Decision: a trip out of town is a deliberate part of the day. Lunch 110 minutes away in Parma
// between two Bologna sights, leaving Milan for Lake Como at 16:00 with no way back for dinner,
// or 65 minutes each way for a 30-minute look at the lakefront are plans nobody would make; nor
// is Modena, back to Bologna for lunch, then out again to Maranello: one trip out a day.
function outOfTownAllowed(next: NextStop, day: DaySoFar): boolean {
  const { place } = next;
  if (place.city === day.anchor.name) return true;
  const away = day.today.filter((other) => other.city !== day.anchor.name);
  if (away.length > 0) {
    const stillAway = day.today.at(-1)?.city !== day.anchor.name;
    return stillAway && inSatelliteArea(place, day.today, day.anchor);
  }
  const worthTheTrip = place.durationMin >= next.travelMin;
  return next.role === "visit" && day.clock <= LEAVE_TOWN_BY && worthTheTrip;
}

/** True when lunch is not yet taken and could still start after `start` (MEALS). */
function beforeLunch(start: number, taken: readonly Meal[]): boolean {
  return !taken.includes("lunch") && start < MEALS.lunch.latestStart;
}

/** True for an aperitivo visit starting before APERITIVO_EARLIEST_START. */
function isEarlyAperitivo(place: Pick<Place, "name">, start: number): boolean {
  return PRE_DINNER_NAME.test(place.name) && start < APERITIVO_EARLIEST_START;
}

function mealStillPossible(next: NextStop, taken: readonly Meal[]): boolean {
  return (["lunch", "dinner"] as const).some((meal) => {
    const latest = next.latest?.[meal];
    return (
      !taken.includes(meal) &&
      servesMeal(next.place, meal) &&
      latest !== undefined &&
      next.arrive <= latest
    );
  });
}

/**
 * The indexes of the stops of a timed day that break one of its preferences: an ordinary outing
 * starting after OUTING_LATEST_START, an ordinary daylight place or tasting ending too late
 * (daylightEnd), an ordinary pre-dinner stop after dinner, an ordinary treat before noon, an
 * ordinary aperitivo before APERITIVO_EARLIEST_START, an ordinary museum on a holiday
 * (closedForHoliday), an ordinary treat right before lunch, and a meal place visited before a
 * stop that takes a meal it serves. The passes that change a finished day (route.ts, mealFill.ts)
 * never accept a change that adds one, and the must-include repair (mustRepair.ts) drops an
 * ordinary stop its insertion pushes into one.
 */
// Decision: a treat before lunch, not before dinner. Gelato at 12:05 and lunch at 12:55 spoils
// the lunch (the route pass made 414 such days to save a few minutes); the stop before dinner is
// the afternoon's last, often hours earlier, and a glass of wine before dinner is an aperitivo.
export function dayRuleBreaks(
  stops: readonly Stop[],
  places: readonly Place[],
  date: string,
  mustInclude: readonly string[],
): number[] {
  const breaking: number[] = [];
  let afterDinner = false;
  stops.forEach((stop, index) => {
    const place = places[index];
    if (!place) return;
    const ordinary = !mustInclude.includes(place.id);
    const visit = stop.role === "visit";
    const later = stops.slice(index + 1);
    const treat = AFTER_NOON_NAME.test(place.name);
    const breaks =
      (ordinary && visit && isOuting(place) && stop.start > OUTING_LATEST_START) ||
      (ordinary && stop.end > daylightEnd(place, date)) ||
      (ordinary && afterDinner && visit && isPreDinner(place)) ||
      (ordinary && treat && stop.start < TREAT_EARLIEST_START) ||
      (ordinary && treat && later[0]?.role === "lunch") ||
      (ordinary && visit && isEarlyAperitivo(place, stop.start)) ||
      (ordinary && closedForHoliday(place, date)) ||
      (visit && later.some((other) => other.role !== "visit" && servesMeal(place, other.role)));
    if (breaks) breaking.push(index);
    if (stop.role === "dinner") afterDinner = true;
  });
  return breaking;
}
