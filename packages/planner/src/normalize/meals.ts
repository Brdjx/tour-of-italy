import { EXTRA_MEAL_PLACES, MEALS } from "../config";
import { formatClock, WEEKDAYS } from "../time";
import type {
  DataIssue,
  DateRule,
  Meal,
  Normalized,
  PlaceType,
  TimeRange,
  Weekday,
  WeeklyHours,
} from "../types";
import { lookup, makeIssue } from "./issue";

// Which meals a place can serve. Restaurants start with lunch and dinner; the reviewed allowlist
// in config gives other food places their meals. A meal stays only if, on some open weekday, the
// whole visit fits inside one open range with a start inside that meal's window.

export interface MealsContext {
  placeId: string;
  type: PlaceType;
  hours: WeeklyHours | null; // null when unknown: every candidate meal is kept
  durationMin: number; // visit length after clamping
  dateRules: DateRule[]; // weekday rules remove days
}

/** Candidate meals before the hours check. */
export function candidateMeals(id: string, type: PlaceType): Meal[] {
  if (type === "restaurant") return ["lunch", "dinner"];
  return [...(lookup(EXTRA_MEAL_PLACES, id)?.meals ?? [])];
}

/** Meals the place can actually serve on at least one weekday. Pure; never throws. */
// Decision: a restaurant open only in the evening is never offered for lunch, so the AI
// shortlist, the swap list, and the planner never pick a meal the validator would reject.
export function normalizeMeals(context: MealsContext): Normalized<Meal[]> {
  const candidates = candidateMeals(context.placeId, context.type);
  const hours = context.hours;
  if (hours === null) return { value: candidates, issues: [] };
  const days = WEEKDAYS.filter((day) => weekdayAllowed(context.dateRules, day));
  const value: Meal[] = [];
  const issues: DataIssue[] = [];
  for (const meal of candidates) {
    const fits = days.some((day) =>
      hours[day].some((range) => mealFits(range, meal, context.durationMin)),
    );
    if (fits) {
      value.push(meal);
      continue;
    }
    const window = MEALS[meal];
    const detail = `No open day can hold a ${context.durationMin}-minute ${meal} starting between ${formatClock(window.earliestStart)} and ${formatClock(window.latestStart)}`;
    const target = { placeId: context.placeId, field: "hours" };
    issues.push(makeIssue(target, "meal_unavailable", meal, detail, `Not offered for ${meal}`));
  }
  return { value, issues };
}

/** True when a meal can start inside its window in this range and finish before it closes. */
export function mealFits(range: TimeRange, meal: Meal, durationMin: number): boolean {
  const window = MEALS[meal];
  const start = Math.max(range.open, window.earliestStart);
  return start <= window.latestStart && start + durationMin <= range.close;
}

function weekdayAllowed(rules: DateRule[], day: Weekday): boolean {
  return rules.every((rule) => rule.kind !== "weekdays" || rule.days.includes(day));
}
