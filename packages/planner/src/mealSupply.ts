import { dayOrigin, transferMinutes } from "./anchors";
import { MIN_SUGGEST_RATING, PACE } from "./config";
import {
  coversMeal,
  earliestMealStart,
  isExcluded,
  isSuggestable,
  servesMeal,
  withinBudget,
} from "./constraints";
import { type PlannerContext, placesOfAnchor, twinIds } from "./context";
import { isValidIsoDate, MONTH_SHORT, monthDayOf, openStatusOn } from "./time";
import { latestReturn, travelMinutes } from "./travel";
import type { Anchor, DayPlan, Itinerary, Meal, Place, TripRequest } from "./types";
import { hasValidTimes } from "./validate/days";
import { dateText, listText, weekdayPlural } from "./validate/text";

// Why a day has no lunch or no dinner, and which cities leave a day with no meal to have. Two
// causes, which ask for different ways out: none open (no place of the base that the traveler
// does not avoid can take the meal that date, so the way out is another city for that day) and
// not planned (a place could take it, so a stop could give way to it). The page names the cause
// on the day's chip (mealGaps) and warns before a city is chosen for a day (mealFacts).
// Decision: a place "can take" a meal when it serves it, the traveler does not avoid it, it is
// open that date for the meal's length with a start inside the meal window, and it fits the day as
// its only stop: reached from the base after the day's start (the travel in included) and left
// with time to get back. The budget is left out: it is the traveler's setting, not the city's. So
// "none open" is only said when nothing could change it but another city or date.
// Decision: a place rated below the planner's floor (isSuggestable) cannot take the meal, unless
// the traveler asked for it. Neither the planner, the meal code adds nor a swap ever offers it, so
// naming it as a place that could take the meal was a way out that could not work. Found in review
// (2026-09-26): every "not planned" lunch in Rome counted and listed Hard Rock Cafe Rome (2.1).
// Decision: only places to eat count, not an outing the validator lets stand in for a meal (a day
// trip under way through it). Review (2026-09-26) asked about the risotto festival, which by that
// rule gives a Bologna day its lunch on the Sundays of October. But every outing of the Bologna
// base has no listed hours, so the Parma tour, whose note says it runs on weekday mornings, could
// be timed 14:00 to 20:00 through every Monday dinner, and the owner's warning would go.
// Found by the owner (2026-09-26): Bologna on Monday 12 October had no dinner, and the page said
// to swap a stop near that meal time, but none of Bologna's three dinner places opens on Mondays.

/** Why a meal place cannot take a meal on a date. */
export type MealBlock =
  | "avoided" // the traveler asked to avoid it
  | "closed_weekday" // closed on that weekday: its weekly hours, or a rule of weekdays
  | "closed_date" // closed on that date: a season, or a rule of days of the month
  | "hours" // open that date, but not for the meal inside its window
  | "out_of_reach" // it fits its hours, but not the day: too late after the travel, or back too late
  | "low_rating"; // it fits the day, but is rated below what the planner suggests and not asked for

/** One place of the base that serves the meal, and whether it can take it that day. */
export interface MealPlaceStatus {
  placeId: string;
  name: string;
  town: string | null; // its town when outside the base's city and not in its name: "Modena"
  block: MealBlock | null; // why it cannot take the meal that day; null when it can
  why: string; // the block in words that follow "is": "closed on Mondays"; "" when it can
  overBudget: boolean; // above the traveler's price level (never a reason it cannot take it)
}

/** One place of the base for a missing meal, with the day of the trip that has it. */
export interface MealGapPlace extends MealPlaceStatus {
  day: number | null; // the day (0-based) holding it or a place at its spot; null when no day does
}

/** Which of the two causes leaves a day without a meal. */
export type MealGapCause = "none_open" | "not_planned";

/** A lunch or dinner a day of a plan does not have, and why. */
export interface MealGap {
  day: number; // 0-based
  meal: Meal;
  cause: MealGapCause;
  text: string; // one sentence for the traveler; "" when the day's base or date is not known
  places: MealGapPlace[]; // every place of the base that serves the meal, those that can take it first
}

const MEAL_ORDER: readonly Meal[] = ["lunch", "dinner"];

const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

/** "three" for 3; digits past ten. */
function countText(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/** "Two" for 2, to start a sentence. */
function countTitle(count: number): string {
  const text = countText(count);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "12 Oct" for 2026-10-12. Throws RangeError on a bad date. */
function shortDate(date: string): string {
  const { month, day } = monthDayOf(date);
  return `${day} ${MONTH_SHORT[month - 1]}`;
}

/**
 * Why `place` cannot take `meal` on `date` for a day at `anchor` whose places can start at
 * `startMin` (the pace's start plus any travel in), or null when it can. Throws RangeError on a
 * bad date.
 */
function blockOf(
  place: Place,
  meal: Meal,
  date: string,
  startMin: number,
  anchor: Anchor,
  request: TripRequest,
): { block: MealBlock; why: string } | null {
  if (isExcluded(place, request)) return { block: "avoided", why: "on your avoid list" };
  const status = openStatusOn(place, date);
  if (status.state === "closed") {
    if (status.reason === "weekly" || status.rule?.kind === "weekdays") {
      return { block: "closed_weekday", why: `closed on ${weekdayPlural(date)}` };
    }
    if (status.reason === "season") return { block: "closed_date", why: "closed for the season" };
    return { block: "closed_date", why: `closed on ${shortDate(date)}` };
  }
  if (earliestMealStart(place, date, 0, meal, place.durationMin) === null) {
    return { block: "hours", why: `not open for ${meal} that day` };
  }
  const origin = dayOrigin(anchor, request);
  const arrive = startMin + travelMinutes(origin, place);
  const start = earliestMealStart(place, date, arrive, meal, place.durationMin);
  if (start === null) return { block: "out_of_reach", why: "not reachable in time that day" };
  const end = start + place.durationMin;
  const dayEnd = PACE[request.pace].dayEnd;
  if (end > dayEnd || end + travelMinutes(place, origin) > latestReturn(dayEnd, meal)) {
    return { block: "out_of_reach", why: "too far to get back from in time" };
  }
  if (!isSuggestable(place, request)) {
    return { block: "low_rating", why: `rated below ${MIN_SUGGEST_RATING}` };
  }
  return null;
}

/** The place's town when it is outside the base's city and its name does not say it. */
function townOf(place: Place, anchor: Anchor): string | null {
  if (place.city === anchor.name || place.name.includes(place.city)) return null;
  return place.city;
}

/**
 * How the page and the sentences name a place of a missing meal: with its town when that is not
 * the base's city ("Osteria Francescana, Modena"), so "Bologna's three dinner places" does not
 * read as three places in Bologna.
 */
export function mealPlaceName(place: Pick<MealPlaceStatus, "name" | "town">): string {
  return place.town === null ? place.name : `${place.name}, ${place.town}`;
}

/**
 * Every place of base `anchorId` that serves `meal`, in id order, with why each cannot take it on
 * `date` for a day whose places can start at `startMin`. Empty for an unknown base. Throws
 * RangeError on a bad date.
 */
export function mealPlaces(
  request: TripRequest,
  anchorId: string,
  meal: Meal,
  date: string,
  startMin: number,
  ctx: PlannerContext,
): MealPlaceStatus[] {
  const anchor = ctx.anchorById.get(anchorId);
  if (!anchor) return [];
  return placesOfAnchor(ctx, anchorId)
    .filter((place) => servesMeal(place, meal))
    .map((place) => {
      const blocked = blockOf(place, meal, date, startMin, anchor, request);
      return {
        placeId: place.id,
        name: place.name,
        town: townOf(place, anchor),
        block: blocked?.block ?? null,
        why: blocked?.why ?? "",
        overBudget: !withinBudget(place, request.maxPriceLevel),
      };
    });
}

/**
 * Why no place can take the meal, in one sentence: "Bologna's three dinner places are all closed
 * on Mondays.", or with reasons that differ, "Of Bologna's three lunch places, two are closed on
 * Sundays and one is not reachable in time that day." Counts, not names: the page lists the
 * names, and a name may hold a comma ("Enoteca Italiana, Bologna").
 */
function noneOpenText(city: string, meal: Meal, places: readonly MealPlaceStatus[]): string {
  if (places.length === 0) return `${city} has no ${meal} place.`;
  const groups = new Map<string, number>();
  for (const place of places) groups.set(place.why, (groups.get(place.why) ?? 0) + 1);
  const ordered = [...groups].sort((a, b) => b[1] - a[1]);
  const [only] = ordered;
  if (ordered.length === 1 && only !== undefined) {
    if (places.length === 1) return `${city}'s only ${meal} place is ${only[0]}.`;
    return `${city}'s ${countText(places.length)} ${meal} places are all ${only[0]}.`;
  }
  const parts = ordered.map(
    ([why, count]) => `${countText(count)} ${count === 1 ? "is" : "are"} ${why}`,
  );
  return `Of ${city}'s ${countText(places.length)} ${meal} places, ${listText(parts)}.`;
}

/**
 * Who could take the meal, in one sentence, when a place can: the free places within the budget,
 * or else why none of the places that could is one ("already in the trip", "over your budget").
 */
function notPlannedText(city: string, meal: Meal, places: readonly MealGapPlace[]): string {
  const open = places.filter((place) => place.block === null);
  const free = open.filter((place) => place.day === null);
  const within = free.filter((place) => !place.overBudget);
  const [first] = within;
  if (first === undefined) {
    const every = `Every place in ${city} that could take ${meal} that day is`;
    if (free.length === 0) return `${every} already in the trip.`;
    if (free.length === open.length) return `${every} over your budget.`;
    return `${every} already in the trip or over your budget.`;
  }
  if (within.length === 1) return `${mealPlaceName(first)} could take ${meal} that day.`;
  return `${countTitle(within.length)} places in ${city} could take ${meal} that day.`;
}

/** True when the stop is an outing under way through the meal's window (as the validator says). */
function outingCovers(stop: DayPlan["stops"][number], meal: Meal, ctx: PlannerContext): boolean {
  const place = ctx.placesById.get(stop.placeId);
  return (
    place !== undefined && hasValidTimes(stop) && coversMeal(place, stop.start, stop.end, meal)
  );
}

/**
 * The lunch and dinner a day has no stop for, lunch first: no stop in that role and no outing
 * under way through it, as the validator's MEAL_MISSING counts them. Empty for an empty day.
 */
export function mealsMissing(day: Pick<DayPlan, "stops">, ctx: PlannerContext): Meal[] {
  if (day.stops.length === 0) return [];
  return MEAL_ORDER.filter(
    (meal) => !day.stops.some((stop) => stop.role === meal || outingCovers(stop, meal, ctx)),
  );
}

/** The day (0-based) of the trip that holds each place, or a place at its spot; the first wins. */
function holders(trip: Pick<Itinerary, "days">, ctx: PlannerContext): Map<string, number> {
  const held = new Map<string, number>();
  for (let index = trip.days.length - 1; index >= 0; index--) {
    for (const stop of (trip.days[index] as DayPlan).stops) {
      for (const id of [stop.placeId, ...twinIds(ctx, stop.placeId)]) held.set(id, index);
    }
  }
  return held;
}

/**
 * The lunch and dinner day `dayIndex` of the plan does not have, each with its cause, the places
 * of the base that serve it and a sentence for the traveler. A meal is had exactly as the
 * validator's MEAL_MISSING says (a stop in that role, or an outing under way through it), so each
 * of those warnings has one gap here and each gap one warning; an empty day has none (EMPTY_DAY
 * says it all). A day whose base or date is not known (the plan already has an error) is "not
 * planned" with no places. Pure.
 */
export function dayMealGaps(
  trip: Pick<Itinerary, "request" | "days">,
  dayIndex: number,
  ctx: PlannerContext,
): MealGap[] {
  const day = trip.days[dayIndex];
  const missing = day ? mealsMissing(day, ctx) : [];
  if (!day || missing.length === 0) return [];
  const anchor = ctx.anchorById.get(day.anchorId);
  if (!anchor || !isValidIsoDate(day.date)) {
    return missing.map((meal) => ({
      day: dayIndex,
      meal,
      cause: "not_planned",
      text: "",
      places: [],
    }));
  }
  const previous = ctx.anchorById.get(trip.days[dayIndex - 1]?.anchorId ?? "");
  const transferMin = dayIndex > 0 && previous ? transferMinutes(previous, anchor) : 0;
  const startMin = PACE[trip.request.pace].dayStart + transferMin;
  const held = holders(trip, ctx);
  return missing.map((meal) => {
    const statuses = mealPlaces(trip.request, anchor.id, meal, day.date, startMin, ctx);
    const places = statuses
      .map((status) => ({ ...status, day: held.get(status.placeId) ?? null }))
      .sort((a, b) => rank(a) - rank(b));
    const open = places.some((place) => place.block === null);
    return {
      day: dayIndex,
      meal,
      cause: open ? "not_planned" : "none_open",
      text: open
        ? notPlannedText(anchor.name, meal, places)
        : noneOpenText(anchor.name, meal, places),
      places,
    };
  });
}

/** Free places that can take the meal first, then the ones a day holds, then the blocked. */
function rank(place: MealGapPlace): number {
  if (place.block !== null) return 2;
  return place.day === null ? 0 : 1;
}

/** Every missing lunch and dinner of the plan, day by day (dayMealGaps). Pure. */
export function mealGaps(
  trip: Pick<Itinerary, "request" | "days">,
  ctx: PlannerContext,
): MealGap[] {
  return trip.days.flatMap((_, index) => dayMealGaps(trip, index, ctx));
}

/**
 * The facts for a city on a day, before anything is planned: a line for each meal no place of the
 * base can take that date, for a day whose places can start at `startMin` after the travel from
 * `fromCity` (null when the day starts without travel). "No dinner in Bologna on Mondays." when
 * every place is closed that weekday; "No lunch in Bologna after the travel from Rome." when the
 * travel in leaves none in reach; else "No dinner in Bologna on Mon 12 Oct 2026."; with ", apart
 * from places you avoid" when the traveler avoids one that could. Empty when both meals can be
 * had. Throws RangeError on a bad date.
 */
// Decision: a fact, not a refusal. The city stays a choice (decision 16: travel and meals are the
// traveler's call), and the line says what the day will lack before it is planned, as the travel
// lines do. The day's start after its travel counts: Rome to Bologna at a relaxed pace starts at
// 12:35, after Via Drapperie's last lunch on a Monday.
export function mealFacts(
  request: TripRequest,
  anchorId: string,
  date: string,
  startMin: number,
  fromCity: string | null,
  ctx: PlannerContext,
): string[] {
  const anchor = ctx.anchorById.get(anchorId);
  if (!anchor) return [];
  return MEAL_ORDER.flatMap((meal) => {
    const places = mealPlaces(request, anchorId, meal, date, startMin, ctx);
    if (places.some((place) => place.block === null)) return [];
    if (places.length === 0) return [`No ${meal} place in ${anchor.name}.`];
    const reasons = places.filter((place) => place.block !== "avoided");
    const avoided = reasons.length < places.length ? ", apart from places you avoid" : "";
    const weekly = reasons.length > 0 && reasons.every((p) => p.block === "closed_weekday");
    const late = fromCity !== null && reasons.some((p) => p.block === "out_of_reach");
    const when = weekly
      ? `on ${weekdayPlural(date)}`
      : late
        ? `after the travel from ${fromCity}`
        : `on ${dateText(date)}`;
    return [`No ${meal} in ${anchor.name} ${when}${avoided}.`];
  });
}
