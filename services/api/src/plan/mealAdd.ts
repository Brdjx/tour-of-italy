import {
  addMissingMeals,
  type DaySelection,
  type PlannerContext,
  type TripRequest,
  type Violation,
} from "@italy/planner";
import type { LlmSelection } from "../llm/client";
import type { Shortlist } from "./candidates";
import type { Materialized } from "./materialize";
import type { TidyChange } from "./tidy";

// The one step that adds a place to the model's answer: a lunch or dinner a day lacks, once the
// answer has passed the check (POST /api/plan and POST /api/plan/day). The meal is the rules-only
// planner's own choice (addMissingMeals, packages/planner/src/mealFill.ts), from the places the
// shortlist offered the model, seated only where it moves no stop out of its order or its role.
// Decision: "code tidies, AI chooses" (decision 1) is amended for meals only (decision 17). A
// timetable without dinner when a restaurant of the city was open and free is a defect the
// traveler sees, and the model cannot see the times that would tell it: on the recorded evals,
// 26% of Sonnet 5's days and 72% of Haiku 4.5's lacked a lunch or dinner, against 19% of the
// rules-only planner's. The model's stops all stay, in its order; the added stop carries a rule
// reason, the trace records it ("meal_added"), and the plan is "ai_repaired".

/** The answer with the meals added, what was added, and the check's result for it. */
export interface MealsAdded<T> {
  selection: LlmSelection; // the answer as given when nothing was added
  changes: TidyChange[]; // one meal_added per meal, in day order
  added: ReadonlySet<string>; // the places added
  made: T | null; // `check`'s result for `selection`; null when nothing was added
}

/**
 * `selection`, an answer that passed the check, with each of `days` given the lunch and dinner it
 * lacks where the rules' meal fill seats a place the shortlist offers (addMissingMeals). Days go in
 * order and each day's meals are kept only when `check` accepts the answer with them (it times
 * and checks the answer again, knowing which places code added, and returns null to refuse).
 */
export function withMealsAdded<T>(
  selection: LlmSelection,
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
  days: readonly number[],
  check: (selection: LlmSelection, added: ReadonlySet<string>) => T | null,
): MealsAdded<T> {
  let current = selection;
  let made: T | null = null;
  const added = new Set<string>();
  const changes: TidyChange[] = [];
  const allowed = (place: { id: string }) => shortlist.placeIds.has(place.id);
  for (const day of days) {
    const trip = current.days.map((one) => ({ anchorId: one.anchorId, placeIds: one.placeIds }));
    const fed = addMissingMeals(request, trip, ctx, { only: [day], allowed });
    if (fed.added.length === 0) continue;
    const next: LlmSelection = {
      ...current,
      days: current.days.map((one, index) =>
        index === day ? { ...one, placeIds: [...(fed.days[index] as DaySelection).placeIds] } : one,
      ),
    };
    const withNew = new Set([...added, ...fed.added.map((meal) => meal.placeId)]);
    const checked = check(next, withNew);
    if (checked === null) continue;
    current = next;
    made = checked;
    for (const meal of fed.added) {
      added.add(meal.placeId);
      changes.push({ rule: "meal_added", day: meal.day, placeId: meal.placeId });
    }
  }
  return { selection: current, changes, added, made };
}

/** `made` when it has no error, else null: a meal stays only in an answer that still passes. */
export function withoutErrors<T extends { errors: readonly Violation[] }>(made: T): T | null {
  return made.errors.length === 0 ? made : null;
}

/**
 * The plan with the meals (`after`) when it has no error and no warning the plan without them
 * (`before`) lacks, other than one about a place code added (the meal's own OVER_BUDGET when it is
 * one price level over, as the rules planner seats it); else null.
 */
export function keptPlan(
  before: Materialized,
  after: Materialized,
  added: ReadonlySet<string>,
): Materialized | null {
  const key = (v: Violation) => `${v.code}|${v.day ?? ""}|${v.placeId ?? ""}`;
  const had = new Set(before.itinerary.warnings.map(key));
  const fresh = after.itinerary.warnings.filter(
    (v) => !had.has(key(v)) && (v.placeId === undefined || !added.has(v.placeId)),
  );
  return fresh.length === 0 ? withoutErrors(after) : null;
}
