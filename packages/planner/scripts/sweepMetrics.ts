import { LONG_TRANSFER_MIN, PACE, TRAVEL } from "../src/config";
import type { PlannerContext } from "../src/context";
import { dayRuleBreaks } from "../src/dayRules";
import { haversineKm } from "../src/normalize/geo";
import { EVENING_FROM, LEAVE_TOWN_BY, SATELLITE_AREA_KM } from "../src/planPolicy";
import type { DayPlan, Itinerary, Place, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";

// What the sweep measures on one plan (measurePlan) and over many (summarize). Every number is
// computed here from the plan's own stops, the independent validator, and the day rules of the
// checked-out planner, never from the planner copy under test, so a copy with a pass removed is
// judged by the same yardstick as the original.

/** Stops starting later than this count as late (22:00). */
const LATE_START = 22 * 60;
/** A daytime wait longer than this is a gap in the plan (twice the walk's "can start now"). */
const LONG_WAIT_MIN = 60;

/** The measurements of one plan. `failed` is set when the planner threw. */
export interface PlanRow {
  n: number;
  segments: string[];
  ms: number;
  failed?: string;
  fingerprint?: string;
  errors?: string[]; // validator error codes
  visits?: number[]; // per day
  lunchMissing?: number; // days
  dinnerMissing?: number; // days
  mealMissingDays?: number; // days missing lunch or dinner
  mealless?: number; // days with neither
  longWaits?: number; // days with a daytime wait over LONG_WAIT_MIN
  bases?: number;
  longTransfer?: boolean;
  travelMin?: number[]; // per day: legs plus the trip back, not the transfer between bases
  waitMin?: number[]; // per day: daytime waits between stops
  stops?: number;
  lateStops?: number;
  interestStops?: number; // non-meal stops, only when the request has interests
  interestMatches?: number;
  mustWanted?: number;
  mustPlaced?: number;
  mustMistimed?: number; // placed must-includes timed against a day rule
  iconic?: number; // visits to places tagged iconic
  notChosen?: boolean; // some day at a base the traveler did not choose
  ruleBreaks?: number; // ordinary stops breaking a day rule (dayRules.ts)
  townBreaks?: number; // days whose trip out of town a traveler would not plan (townBreak)
  mealVisits?: number; // ordinary meal places planned as sights
  overBudget?: number; // ordinary stops over the budget
}

/** The request's segments: the slices of the sweep a targeted rule is judged on. */
export function segmentsOf(request: TripRequest, dates: readonly string[]): string[] {
  const segments = ["all"];
  if (dates.some((date) => /-(12-25|01-01)$/.test(date))) segments.push("holiday");
  if (request.mustInclude.length > 0) segments.push("must");
  if (request.anchors !== "auto") segments.push("chosen");
  if (request.maxPriceLevel === 1) segments.push("budget1");
  if (request.exclude.length > 0) segments.push("exclude");
  return segments;
}

/** Every measurement of one plan, judged against `ctx` (the checked-out planner's context). */
export function measurePlan(
  itinerary: Itinerary,
  ctx: PlannerContext,
): Omit<PlanRow, "n" | "ms" | "segments"> {
  const { request } = itinerary;
  const violations = validateItinerary(itinerary, ctx);
  const errors = violations.filter((v) => v.severity === "error").map((v) => v.code);
  const missing = (meal: string) =>
    violations.filter((v) => v.code === "MEAL_MISSING" && v.detail.includes(`no ${meal}`));
  const lunch = new Set(missing("lunch").map((v) => v.day));
  const dinner = new Set(missing("dinner").map((v) => v.day));
  const place = (id: string) => ctx.placesById.get(id) as Place;
  const wanted = request.mustInclude.filter(
    (id) => ctx.placesById.has(id) && !request.exclude.includes(id),
  );
  const planned = new Set(itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
  const row: ReturnType<typeof measurePlan> = {
    fingerprint: fingerprint(itinerary),
    errors,
    visits: itinerary.days.map((day) => day.stops.filter((s) => s.role === "visit").length),
    lunchMissing: lunch.size,
    dinnerMissing: dinner.size,
    mealMissingDays: new Set([...lunch, ...dinner]).size,
    mealless: [...lunch].filter((day) => dinner.has(day)).length,
    longWaits: itinerary.days.filter((day) => longestWait(day.stops) > LONG_WAIT_MIN).length,
    bases: new Set(itinerary.days.map((day) => day.anchorId)).size,
    longTransfer: itinerary.days.some((day) => day.transferMin > LONG_TRANSFER_MIN),
    travelMin: itinerary.days.map(
      (day) =>
        day.stops.reduce((sum, stop) => sum + stop.travelFromPrevMin, 0) +
        (day.returnTravelMin ?? 0),
    ),
    waitMin: itinerary.days.map((day) => waits(day.stops).reduce((a, b) => a + b, 0)),
    stops: itinerary.days.reduce((sum, day) => sum + day.stops.length, 0),
    lateStops: itinerary.days.reduce(
      (sum, day) => sum + day.stops.filter((stop) => stop.start > LATE_START).length,
      0,
    ),
    mustWanted: wanted.length,
    mustPlaced: wanted.filter((id) => planned.has(id)).length,
    mustMistimed: itinerary.days.reduce((sum, day) => {
      const places = day.stops.map((stop) => place(stop.placeId));
      const breaks = dayRuleBreaks(day.stops, places, day.date, []);
      return sum + breaks.filter((at) => wanted.includes(day.stops[at]?.placeId ?? "")).length;
    }, 0),
    iconic: itinerary.days.reduce(
      (sum, day) =>
        sum +
        day.stops.filter((s) => s.role === "visit" && place(s.placeId).tags.includes("iconic"))
          .length,
      0,
    ),
    notChosen: violations.some((v) => v.code === "ANCHOR_NOT_CHOSEN"),
    ruleBreaks: itinerary.days.reduce((sum, day) => {
      const places = day.stops.map((stop) => place(stop.placeId));
      return sum + dayRuleBreaks(day.stops, places, day.date, request.mustInclude).length;
    }, 0),
    townBreaks: itinerary.days.filter((day) => townBreak(day, request, ctx)).length,
    mealVisits: itinerary.days.reduce(
      (sum, day) =>
        sum +
        day.stops.filter(
          (stop) =>
            stop.role === "visit" &&
            place(stop.placeId).mealCapable &&
            !request.mustInclude.includes(stop.placeId),
        ).length,
      0,
    ),
    overBudget: violations.filter(
      (v) => v.code === "OVER_BUDGET" && !request.mustInclude.includes(v.placeId ?? ""),
    ).length,
  };
  if (request.interests.length > 0) {
    const sights = itinerary.days.flatMap((day) => day.stops.filter((s) => s.role === "visit"));
    row.interestStops = sights.length;
    row.interestMatches = sights.filter((stop) =>
      request.interests.some((tag) => place(stop.placeId).tags.includes(tag)),
    ).length;
  }
  return row;
}

/**
 * The daytime waits between stops: before each stop after the first that starts before 18:00
 * and is not dinner, the minutes between arriving and starting.
 */
export function waits(stops: DayPlan["stops"]): number[] {
  const found: number[] = [];
  stops.forEach((stop, index) => {
    const previous = stops[index - 1];
    if (!previous || stop.role === "dinner" || stop.start >= EVENING_FROM) return;
    found.push(stop.start - (previous.end + stop.travelFromPrevMin + TRAVEL.bufferMin));
  });
  return found;
}

function longestWait(stops: DayPlan["stops"]): number {
  return Math.max(0, ...waits(stops));
}

/**
 * True when the day's trip out of town is one a traveler would not plan, counting only places
 * they did not ask for: leaving town twice, two out-of-town stops more than SATELLITE_AREA_KM
 * apart, or a trip out that starts with a meal, leaves after LEAVE_TOWN_BY, or is shorter than
 * the journey there.
 */
export function townBreak(day: DayPlan, request: TripRequest, ctx: PlannerContext): boolean {
  const base = ctx.anchorById.get(day.anchorId)?.name ?? "";
  const ordinary = (id: string) => !request.mustInclude.includes(id);
  let trips = 0;
  let away: Place[] = [];
  let free = PACE[request.pace].dayStart + day.transferMin;
  for (const stop of day.stops) {
    const place = ctx.placesById.get(stop.placeId) as Place;
    const out = place.city !== base;
    if (out && away.length === 0 && ordinary(place.id)) {
      trips++;
      const late = free > LEAVE_TOWN_BY || place.durationMin < stop.travelFromPrevMin;
      if (stop.role !== "visit" || late) return true;
    }
    if (out && ordinary(place.id) && away.some((o) => haversineKm(o, place) > SATELLITE_AREA_KM)) {
      return true;
    }
    away = out ? [...away, place] : [];
    free = stop.end;
  }
  return trips > 1;
}

/** A short hash of the plan's bases, stops, roles, and times, to count changed plans. */
function fingerprint(itinerary: Itinerary): string {
  const text = itinerary.days
    .map((day) => `${day.anchorId}:${day.stops.map((s) => `${s.placeId}@${s.start}${s.role[0]}`)}`)
    .join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16);
}
