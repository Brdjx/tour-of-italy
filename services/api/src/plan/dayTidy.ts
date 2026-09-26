import {
  type DayPlan,
  type DaySelection,
  mustIncludesLeftOut,
  newTripErrors,
  type PlannerContext,
  scheduleTrip,
  sharesLocation,
  usedOnOtherDays,
  type Violation,
  withDay,
} from "@italy/planner";
import type { LlmDayAnswer, LlmSelection } from "../llm/client";
import type { Shortlist } from "./candidates";
import type { DayInput } from "./dayInput";
import { dedupe, shortlistViolations } from "./materialize";
import { applyAiReasons, type ReasonStats } from "./reasons";
import { type Tidied, type TidyChange, tidySelection } from "./tidy";

// The model's one-day answer, tidied and checked (POST /api/plan/day). The tidy step is the
// whole-trip one (tidy.ts), run on the trip with this day in it and the other days as they are,
// after one step of its own: a place another day has, or one at the same spot, is taken out
// first. The check is the whole-trip check narrowed to this day: every id offered, and no error
// the trip did not already have (newTripErrors, packages/planner/src/dayChecks.ts).

/** A tidied day answer: its ids and reasons, what was changed, and the trip it sits in. */
export interface DayTidied {
  ids: string[];
  reasons: LlmDayAnswer["reasons"];
  changes: TidyChange[]; // on this day only, in the order they were made
  trip: Tidied; // the whole trip as tidied (other days as sent), for the repair notes
}

/**
 * The answer tidied. It never adds a place (a meal the day lacks may be added once the day passes
 * the check, mealAdd.ts), never changes the day's base, and never changes another day: a place of
 * another day (or at its spot) is dropped from this one ("duplicate", "same_spot"), then
 * tidySelection drops closed places, fixes the order, and trims what the day's hours and pace
 * cannot hold, keeping must-includes.
 */
// Decision: repeats of other days are dropped here, before tidySelection. Its own rule keeps a
// repeat on a day it would otherwise empty and takes the place off the day that had it first,
// which here would change a day the traveler did not ask to change. The other days hold no id of
// this day's shortlist, so tidySelection leaves them as they are (not offered, so never reordered
// or trimmed; a later day of a route, still empty, may be given a place this day drops, asDrop);
// they are put back from the input all the same, and any change it records on them is not this
// day's.
export function tidyDay(
  answer: LlmDayAnswer,
  input: DayInput,
  shortlist: Shortlist,
  ctx: PlannerContext,
): DayTidied {
  const { day } = input;
  const used = usedOnOtherDays(input.days, day);
  const usedPlaces = [...used].flatMap((id) => {
    const place = ctx.placesById.get(id);
    return place ? [place] : [];
  });
  const own: TidyChange[] = [];
  const ids = answer.placeIds.filter((placeId) => {
    const place = ctx.placesById.get(placeId);
    if (used.has(placeId)) own.push({ rule: "duplicate", day, placeId });
    else if (place && usedPlaces.some((other) => sharesLocation(other, place))) {
      own.push({ rule: "same_spot", day, placeId });
    } else return true;
    return false;
  });
  const selection = tripSelection(input, ids, answer.reasons);
  const tidied = tidySelection(selection, input.request, shortlist, ctx);
  const tidiedDay = tidied.selection.days[day] ?? { placeIds: [], reasons: [] };
  const changes = [...own, ...tidied.changes.filter((change) => change.day === day).map(asDrop)];
  const trip = tripSelection(input, tidiedDay.placeIds, tidiedDay.reasons);
  return {
    ids: [...tidiedDay.placeIds],
    reasons: tidiedDay.reasons,
    changes,
    trip: { selection: trip, changes },
  };
}

/**
 * A place the trip's tidy step moved to another day, recorded as the drop that took it off this
 * day: the other days are put back as sent, so for this day the place is gone, not moved.
 */
// Decision: found in the live route check (2026-09-26). A later day of a route waits its turn
// empty, at a base this day may share, so step 8 of the tidy step can move a place this day drops
// onto it. The answer keeps this day only, so the trace and the repair notes name the drop.
function asDrop(change: TidyChange): TidyChange {
  if (change.rule !== "moved_day" || change.cause === undefined) return change;
  const { toDay: _toDay, cause, ...rest } = change;
  return { ...rest, rule: cause };
}

/** The trip as a model selection, with this day's ids and reasons and the other days as sent. */
function tripSelection(
  input: DayInput,
  ids: readonly string[],
  reasons: LlmDayAnswer["reasons"],
): LlmSelection {
  return {
    days: input.days.map((other, index) =>
      index === input.day
        ? { anchorId: input.anchorId, placeIds: [...ids], reasons }
        : { anchorId: other.anchorId, placeIds: [...other.placeIds], reasons: [] },
    ),
    summary: "",
  };
}

/** A day timed with its reasons, and every error that stops it reaching the traveler. */
export interface MaterializedDay {
  dayPlan: DayPlan;
  errors: Violation[]; // empty when the day may be shown
  reasonStats: ReasonStats;
}

/**
 * The tidied day timed in its trip (the other days as they are, the next one after its new
 * transfer), with the AI reasons that pass the checks and rule reasons for the rest, and its
 * errors: an id or base the day's shortlist did not offer, every error the trip did not already
 * have (any on this day counts), and a must-include the rules' day (`witness`) holds that this
 * day leaves out (mustIncludesLeftOut). `added` holds the meals code added after the check
 * (mealAdd.ts): they keep their rule reasons.
 */
export function materializeDay(
  tidied: Pick<DayTidied, "ids" | "reasons">,
  input: DayInput,
  shortlist: Shortlist,
  ctx: PlannerContext,
  witness: DaySelection,
  added: ReadonlySet<string> = new Set(),
): MaterializedDay {
  const { request, day } = input;
  const selection = tripSelection(input, tidied.ids, tidied.reasons);
  const newDay = { anchorId: input.anchorId, placeIds: tidied.ids };
  const scheduled = scheduleTrip(request, withDay(input.days, day, newDay), ctx);
  const reasoned = applyAiReasons(scheduled.days, selection, ctx, day, added);
  const timed = scheduled.days[day] as DayPlan;
  const dayPlan: DayPlan = { ...timed, stops: reasoned.days[day] ?? timed.stops };
  const errors = dedupe([
    ...shortlistViolations(selection, shortlist, ctx).filter((v) => v.day === day),
    ...scheduled.violations.filter((v) => v.severity === "error" && v.day === day),
    ...newTripErrors(request, input.days, day, newDay, ctx),
    ...mustIncludesLeftOut(request, day, witness, newDay, ctx),
  ]);
  return { dayPlan, errors, reasonStats: reasoned.stats };
}
