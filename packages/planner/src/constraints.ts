import { MEAL_COVER_MIN, MEALS, MIN_SUGGEST_RATING, OUTING_MIN_MINUTES, PACE } from "./config";
import type { PlannerContext } from "./context";
import { type HoursSource, hoursOn } from "./time";
import type { Meal, Pace, Place, PriceLevel, TimeRange, TripRequest } from "./types";

// Hard rules shared by the scheduler, the validator, swap alternatives, and the AI shortlist.
// Each is a small pure function, so every layer answers "can this stop go here" the same way.
// Times are minutes from local midnight on the visit date.

/** Whether a visit fits the hours: "unknown" when the place has no usable hours that day. */
export type OpenAnswer = "yes" | "no" | "unknown";

/** A visit is valid only when both ends are finite and it ends after it starts. */
function isValidVisit(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function fitsRange(range: TimeRange, start: number, end: number): boolean {
  return range.open <= start && end <= range.close;
}

/**
 * Whether the whole visit [start, end] fits inside ONE open range on that date, with season,
 * weekday, and day-of-month rules applied. Both ends are inclusive: a visit may start at opening
 * and end at closing. Visits across a midday break are "no". Unknown hours give "unknown", but a
 * place closed by a date rule is "no" even when its hours are unknown. An invalid visit (end not
 * after start, or non-finite) is "no". Throws RangeError on a bad date.
 */
// Decision: a range that closes after midnight keeps close > 1440 and is only read on its own
// date. Every day window ends before midnight, so carrying it into the next morning never matters.
export function isOpenDuring(
  place: HoursSource,
  date: string,
  start: number,
  end: number,
): OpenAnswer {
  const ranges = hoursOn(place, date);
  if (!isValidVisit(start, end)) return "no";
  if (ranges === "unknown") return "unknown";
  return ranges.some((range) => fitsRange(range, start, end)) ? "yes" : "no";
}

/**
 * The earliest start at or after `notBefore` at which a visit of `durationMin` fits inside one
 * open range on that date, or null when none does. Unknown hours return `notBefore` (the caller
 * adds the HOURS_UNKNOWN warning). Throws RangeError on a bad date.
 */
export function earliestOpenStart(
  place: HoursSource,
  date: string,
  notBefore: number,
  durationMin: number,
): number | null {
  const ranges = hoursOn(place, date);
  if (!isValidVisit(notBefore, notBefore + durationMin)) return null;
  if (ranges === "unknown") return notBefore;
  let best: number | null = null;
  for (const range of ranges) {
    const start = Math.max(notBefore, range.open);
    if (start + durationMin > range.close) continue;
    if (best === null || start < best) best = start;
  }
  return best;
}

// ---------- Day and meal windows ----------

/** The part of the day a pace allows, after a transfer from the previous base. */
export interface DayWindow {
  start: number; // earliest start of any stop, dayStart + transferMin
  end: number; // latest end of any stop, meals included
}

/**
 * The day window for a pace. A transfer from the previous base is deducted from the start of the
 * day. When the transfer eats the whole day, start is after end and nothing fits. Throws
 * RangeError when transferMin is negative or not finite.
 */
export function dayWindow(pace: Pace, transferMin = 0): DayWindow {
  if (!Number.isFinite(transferMin) || transferMin < 0) {
    throw new RangeError(`transferMin must be a non-negative number, got ${transferMin}`);
  }
  const { dayStart, dayEnd } = PACE[pace];
  return { start: dayStart + transferMin, end: dayEnd };
}

/** True when the whole stop fits inside the pace's day window, both ends inclusive. */
// Decision: the window applies to every stop, meals and derived early-morning windows included.
// "Piazza del Popolo at Dawn" (06:00 to 10:00) therefore fits only a pace that starts before
// 10:00 minus its visit length. Letting such places start before dayStart would give the
// scheduler and the validator a second window rule and wake a relaxed traveler at 06:00.
export function withinDayWindow(start: number, end: number, pace: Pace, transferMin = 0): boolean {
  if (!isValidVisit(start, end)) return false;
  const window = dayWindow(pace, transferMin);
  return start >= window.start && end <= window.end;
}

/** True when a meal may start at this time. Both window ends are inclusive (12:00 and 14:30). */
// Decision: inclusive at both ends, matching mealFits in the normalizer, so a place offered for
// lunch because it opens at 12:00 or seats its last table at 14:30 is never rejected here.
export function mealWindowAllows(meal: Meal, start: number): boolean {
  const window = MEALS[meal];
  return Number.isFinite(start) && start >= window.earliestStart && start <= window.latestStart;
}

/**
 * The earliest start at or after `notBefore` for this meal: inside the meal's start window and
 * fitting one open range. Null when there is none. Checks time only; the caller checks
 * servesMeal. Throws RangeError on a bad date.
 */
export function earliestMealStart(
  place: HoursSource,
  date: string,
  notBefore: number,
  meal: Meal,
  durationMin: number,
): number | null {
  const window = MEALS[meal];
  const from = Math.max(notBefore, window.earliestStart);
  const start = earliestOpenStart(place, date, from, durationMin);
  // Any later start is later still, so the first fitting start decides.
  return start !== null && start <= window.latestStart ? start : null;
}

// ---------- Place filters ----------

/** True when the place belongs to this base. Unknown place ids never belong. */
export function belongsToAnchor(placeId: string, anchorId: string, ctx: PlannerContext): boolean {
  return ctx.anchorIdByPlaceId.get(placeId) === anchorId;
}

/** True when the place is within the budget. An unknown price or no budget always passes. */
export function withinBudget(
  place: Pick<Place, "priceLevel">,
  maxPriceLevel: PriceLevel | null,
): boolean {
  if (maxPriceLevel === null || place.priceLevel === null) return true;
  return place.priceLevel <= maxPriceLevel;
}

/**
 * True when the place can be a lunch or dinner stop (restaurants and the reviewed allowlist).
 * With servesMeal below, this is the single meal gate: the scheduler, the look-ahead, the
 * validator, and swaps ask these two functions and never read the fields themselves.
 */
// Decision: a dietary filter (vegetarian) starts here. The data has no dietary field, so it needs
// a reviewed table like EXTRA_MEAL_PLACES; the planner then drops unsuitable meal places from its
// candidates (isCandidate) and both checkers warn about one the traveler added by hand.
export function isMealPlace(place: Pick<Place, "mealCapable">): boolean {
  return place.mealCapable;
}

/**
 * True when the place serves this meal on at least one day its hours allow. `meals` is empty
 * exactly when the place is not a meal place (the normalizer guarantees it).
 */
export function servesMeal(place: Pick<Place, "meals">, meal: Meal): boolean {
  return place.meals.includes(meal);
}

/**
 * True for an outing: a visit of OUTING_MIN_MINUTES or more that is not a meal place (a day trip,
 * a long bike ride, the Vatican Museums).
 */
export function isOuting(place: Pick<Place, "mealCapable" | "durationMin">): boolean {
  return !isMealPlace(place) && place.durationMin >= OUTING_MIN_MINUTES;
}

/**
 * True when an outing timed [start, end] is under way for at least MEAL_COVER_MIN minutes of the
 * meal's start window, so the traveler eats during it (lunch in Siena) and the day needs no
 * separate stop for that meal.
 */
export function coversMeal(
  place: Pick<Place, "mealCapable" | "durationMin">,
  start: number,
  end: number,
  meal: Meal,
): boolean {
  const window = MEALS[meal];
  const overlap = Math.min(end, window.latestStart) - Math.max(start, window.earliestStart);
  return isOuting(place) && overlap >= MEAL_COVER_MIN;
}

/**
 * True when the planner and the AI shortlist may suggest the place: rated at least
 * MIN_SUGGEST_RATING, or asked for by the traveler.
 */
// Decision: a missing rating is suggestable. Scoring already treats it as 3.5, the threshold, and
// hiding every unrated place would punish missing data rather than bad places.
export function isSuggestable(
  place: Pick<Place, "id" | "rating">,
  request: Pick<TripRequest, "mustInclude">,
): boolean {
  if (request.mustInclude.includes(place.id)) return true;
  return place.rating === null || place.rating >= MIN_SUGGEST_RATING;
}

/** True when the traveler excluded the place. */
export function isExcluded(
  place: Pick<Place, "id">,
  request: Pick<TripRequest, "exclude">,
): boolean {
  return request.exclude.includes(place.id);
}

/**
 * True when two places must never be in the same trip: the same spot (a fountain by day and by
 * night) or the same experience. Symmetric even if only one side lists the link. A place is not
 * "shared" with itself; that case is DUPLICATE_PLACE.
 */
export function sharesLocation(
  a: Pick<Place, "id" | "sharedLocationWith">,
  b: Pick<Place, "id" | "sharedLocationWith">,
): boolean {
  if (a.id === b.id) return false;
  return a.sharedLocationWith.includes(b.id) || b.sharedLocationWith.includes(a.id);
}

/**
 * The date-independent filter every suggestion passes: in this base, not excluded, suggestable,
 * and within budget unless the traveler asked for it. Hours, the day window, and trip-level
 * duplicates are checked by the caller.
 */
// Decision: a must-include place over budget is still a candidate. The traveler named it, so the
// plan includes it with an OVER_BUDGET warning instead of dropping it.
export function isCandidate(
  place: Place,
  request: Pick<TripRequest, "exclude" | "mustInclude" | "maxPriceLevel">,
  anchorId: string,
  ctx: PlannerContext,
): boolean {
  if (isExcluded(place, request)) return false;
  if (!belongsToAnchor(place.id, anchorId, ctx)) return false;
  if (!isSuggestable(place, request)) return false;
  return withinBudget(place, request.maxPriceLevel) || request.mustInclude.includes(place.id);
}
