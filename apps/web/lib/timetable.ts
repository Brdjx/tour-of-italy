import {
  type Anchor,
  coversMeal,
  type DayPlan,
  dayWindow,
  type Itinerary,
  type Meal,
  PACE,
  type Place,
  type PlannerContext,
  type Stop,
  TRAVEL,
  travelMode,
  type Violation,
} from "@italy/planner";
import { type Chip, stopChips, violationChip, violationsForDay, violationsForStop } from "./chips";
import { longDate, shortDate, transferText, travelText } from "./format";
import { displayReason } from "./reasonText";

// View model for one day of the timetable: header text, and per stop the travel leg that leads
// to it, the chips, and whether the validator flagged it. Components only lay this out, so all
// the arithmetic is here where it is unit tested.

/** Free time shown between stops only when it is at least this long. */
export const FREE_TIME_MIN = 30;

export interface LegView {
  minutes: number;
  text: string; // "12 min walk", "15 min by taxi or bus from central Rome"
  freeMin: number; // idle time before this stop starts, 0 when under FREE_TIME_MIN
}

export interface RowView {
  index: number;
  stop: Stop;
  place: Place | undefined;
  leg: LegView;
  chips: Chip[];
  flagged: boolean; // the validator reports an error on this stop
  coveredMeals: Meal[]; // a long visit through a meal window on a day without that meal
  reason: string | null; // the why line, without what the row already shows
}

export interface TransferView {
  text: string; // "3 h 5 min by high-speed train from Rome"
  depart: number; // the pace's day start, minutes after midnight
  arrive: number; // when the day's plan can begin
}

export interface DayView {
  index: number;
  day: DayPlan;
  anchorName: string;
  tabLabel: string; // "Tue 6 Oct"
  heading: string; // "Tuesday 6 October"
  stopsText: string; // "4 visits, lunch and dinner"
  transfer: TransferView | null;
  returnLeg: string | null; // "15 min by taxi or bus back to central Rome", when the plan has it
  dayChips: Chip[];
  rows: RowView[];
}

export function buildDayView(
  itinerary: Itinerary,
  dayIndex: number,
  ctx: PlannerContext,
  errors: readonly Violation[],
): DayView | null {
  const day = itinerary.days[dayIndex];
  if (!day) return null;
  const anchor = ctx.anchorById.get(day.anchorId);
  const all = [...errors, ...itinerary.warnings];
  const seated = day.stops.map((stop) => stop.role).filter((role) => role !== "visit");
  const rows = day.stops.map((stop, index) => {
    const place = ctx.placesById.get(stop.placeId);
    const own = violationsForStop(all, dayIndex, index);
    const coveredMeals = mealsCovered(stop, place, seated);
    return {
      index,
      stop,
      place,
      leg: legFor(day, index, ctx, anchor),
      chips: stopChips(place, own),
      flagged: own.some((violation) => violation.severity === "error"),
      coveredMeals,
      reason: displayReason(stop.reason, stop.reasonSource === "ai", {
        place,
        role: stop.role,
        ratingShown: true,
        coveredMeals,
      }),
    };
  });
  return {
    index: dayIndex,
    day,
    anchorName: anchor?.name ?? "Unknown base",
    tabLabel: shortDate(day.date),
    heading: longDate(day.date),
    stopsText: stopsText(day),
    transfer: transferFor(itinerary, dayIndex, ctx),
    returnLeg: returnFor(day, ctx, anchor),
    dayChips: violationsForDay(all, dayIndex).map((violation, index) =>
      violationChip(violation, index),
    ),
    rows,
  };
}

function legFor(
  day: DayPlan,
  index: number,
  ctx: PlannerContext,
  anchor: Anchor | undefined,
): LegView {
  const stop = day.stops[index] as Stop;
  const place = ctx.placesById.get(stop.placeId);
  const minutes = stop.travelFromPrevMin;
  if (index === 0) {
    const mode = anchor && place ? travelMode(anchor.centroid, place) : "local";
    const from = anchor ? ` from central ${anchor.name}` : "";
    const text =
      minutes === 0
        ? `Starts in central ${anchor?.name ?? "town"}`
        : travelText(minutes, mode) + from;
    return { minutes, text, freeMin: 0 };
  }
  const previous = day.stops[index - 1] as Stop;
  const previousPlace = ctx.placesById.get(previous.placeId);
  const mode = previousPlace && place ? travelMode(previousPlace, place) : "local";
  const idle = stop.start - (previous.end + minutes + TRAVEL.bufferMin);
  return { minutes, text: travelText(minutes, mode), freeMin: idle >= FREE_TIME_MIN ? idle : 0 };
}

/** The trip back to the base after the last stop, when the planner reports it. */
function returnFor(day: DayPlan, ctx: PlannerContext, anchor: Anchor | undefined): string | null {
  const minutes = day.returnTravelMin;
  const last = day.stops.at(-1);
  const place = last ? ctx.placesById.get(last.placeId) : undefined;
  if (minutes === undefined || !anchor || !place) return null;
  if (minutes === 0) return `Ends in central ${anchor.name}`;
  return `${travelText(minutes, travelMode(place, anchor.centroid))} back to central ${anchor.name}`;
}

/**
 * Meals a visit stands in for: the validator accepts a long outing under way through a meal
 * window (constraints.ts coversMeal) on a day with no seated stop for that meal. The row says
 * so as a fact, whoever wrote the reason.
 */
export function mealsCovered(
  stop: Stop,
  place: Place | undefined,
  seated: readonly string[],
): Meal[] {
  if (stop.role !== "visit" || !place) return [];
  const meals: Meal[] = [];
  for (const meal of ["lunch", "dinner"] as const) {
    if (!seated.includes(meal) && coversMeal(place, stop.start, stop.end, meal)) meals.push(meal);
  }
  return meals;
}

/** "4 visits, lunch and dinner": the pace limit counts visits, so the header does too. */
export function stopsText(day: DayPlan): string {
  const visits = day.stops.filter((stop) => stop.role === "visit").length;
  const meals = (["lunch", "dinner"] as const).filter((meal) =>
    day.stops.some((stop) => stop.role === meal),
  );
  const visitText = `${visits} ${visits === 1 ? "visit" : "visits"}`;
  const parts = visits > 0 || meals.length === 0 ? [visitText, ...meals] : [...meals];
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function transferFor(
  itinerary: Itinerary,
  dayIndex: number,
  ctx: PlannerContext,
): TransferView | null {
  const day = itinerary.days[dayIndex];
  const previous = itinerary.days[dayIndex - 1];
  if (!day || !previous || day.transferMin <= 0) return null;
  const from = ctx.anchorById.get(previous.anchorId);
  const to = ctx.anchorById.get(day.anchorId);
  if (!from || !to) return null;
  const pace = itinerary.request.pace;
  return {
    text: transferText(day.transferMin, travelMode(from.centroid, to.centroid), from.name),
    depart: PACE[pace].dayStart,
    arrive: dayWindow(pace, day.transferMin).start,
  };
}

/**
 * The day's times as one string, "place_001 540-660|place_007 700-820", in visiting order. Two
 * versions of a day with the same times give the same string, however often the view is rebuilt.
 */
export function dayTimes(rows: readonly RowView[]): string {
  return rows.map((row) => `${row.stop.placeId} ${row.stop.start}-${row.stop.end}`).join("|");
}

/** Places whose times differ between two dayTimes strings. A place new to the day did not move. */
export function movedStops(before: string, now: string): Set<string> {
  const earlier = parseDayTimes(before);
  const moved = new Set<string>();
  for (const [placeId, times] of parseDayTimes(now)) {
    const was = earlier.get(placeId);
    if (was !== undefined && was !== times) moved.add(placeId);
  }
  return moved;
}

function parseDayTimes(text: string): Map<string, string> {
  const entries = text === "" ? [] : text.split("|");
  return new Map(
    entries.map((entry) => {
      const cut = entry.lastIndexOf(" "); // times never hold a space; an id might
      return [entry.slice(0, cut), entry.slice(cut + 1)] as const;
    }),
  );
}

/** The most stops a day's board shows a small photo for: a few highlights, not a photo per row. */
export const DAY_THUMBNAILS = 2;

/**
 * Rows that show a thumbnail: the day's highest-rated stops that have a photo of their own, at
 * most `max`, ties going to the earlier stop. Every other stop shows its photo only when opened.
 */
// Decision: a stop without a rating ranks below every rated stop, so a missing number never
// wins a highlight over a place the data rates.
export function thumbnailRows(
  rows: readonly RowView[],
  hasOwnPhoto: (place: Place) => boolean,
  max: number = DAY_THUMBNAILS,
): Set<number> {
  const ranked = rows
    .filter((row) => row.place !== undefined && hasOwnPhoto(row.place))
    .sort((a, b) => (b.place?.rating ?? -1) - (a.place?.rating ?? -1) || a.index - b.index);
  return new Set(ranked.slice(0, Math.max(0, max)).map((row) => row.index));
}

/** Every day's view, in order. Days whose view cannot be built are skipped. */
export function buildTripView(
  itinerary: Itinerary,
  ctx: PlannerContext,
  errors: readonly Violation[],
): DayView[] {
  const views: DayView[] = [];
  itinerary.days.forEach((_, index) => {
    const view = buildDayView(itinerary, index, ctx, errors);
    if (view) views.push(view);
  });
  return views;
}
