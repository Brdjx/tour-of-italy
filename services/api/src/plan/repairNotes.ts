import {
  addDays,
  PACE,
  type PlannerContext,
  sharesLocation,
  type TripRequest,
} from "@italy/planner";
import type { LlmSelection } from "../llm/client";
import type { RepairNotes } from "../llm/prompt";
import { weekdayName } from "../llm/promptUser";
import type { Shortlist } from "./candidates";
import type { Tidied, TidyChange } from "./tidy";

// What the tidy step did to an answer that still failed the check, in words for the repair turn
// (buildRepairMessage): each stop it removed and why, each stop it moved, and each day left with
// no stops, with the candidates still free for it. Only facts code knows go in: ids, day numbers,
// dates, and the pace's limit.

/** The day of the tidied trip that holds this place, or undefined. */
function dayOf(selection: LlmSelection, placeId: string): number | undefined {
  const index = selection.days.findIndex((day) => day.placeIds.includes(placeId));
  return index < 0 ? undefined : index;
}

/** True when the two ids are one place, or two places at one spot. */
function sameStop(a: string, b: string, ctx: PlannerContext): boolean {
  if (a === b) return true;
  const one = ctx.placesById.get(a);
  const two = ctx.placesById.get(b);
  return one !== undefined && two !== undefined && sharesLocation(one, two);
}

/** Why the tidy step took this place out of this day, in one short clause. */
function why(
  change: TidyChange & { placeId: string },
  tidied: LlmSelection,
  request: TripRequest,
  ctx: PlannerContext,
): string {
  const { placeId, day } = change;
  switch (change.rule) {
    case "closed":
      return `closed on ${dateOf(request, day)}`;
    case "duplicate": {
      const kept = dayOf(tidied, placeId);
      return kept === undefined
        ? "used on another day as well; each id may appear once in the trip"
        : `already on day ${kept + 1}; each id may appear once in the trip`;
    }
    case "same_spot": {
      const twin = tidied.days.flatMap((d) => d.placeIds).find((id) => sameStop(id, placeId, ctx));
      const twinDay = twin === undefined ? undefined : dayOf(tidied, twin);
      return twinDay === undefined
        ? "the same spot as another stop in the trip"
        : `the same spot as ${twin} on day ${twinDay + 1}`;
    }
    case "over_visit_limit":
      return `day ${day + 1} had more visits than the ${request.pace} pace allows (${PACE[request.pace].maxVisits} a day, not counting meals)`;
    case "over_budget_visit": {
      const base = ctx.anchorIdByPlaceId.get(placeId) ?? "its base";
      return `over budget, so only a lunch or dinner, and no day at ${base} had one free for it`;
    }
    default:
      return `day ${day + 1}'s opening hours and travel time could not hold it`;
  }
}

/** "Sunday 2026-10-11" for a 0-based trip day. */
function dateOf(request: TripRequest, day: number): string {
  const date = addDays(request.startDate, day);
  return `${weekdayName(date)} ${date}`;
}

/** One line per day of the tidied answer that has no stops, naming what is still free for it. */
function emptyDayLines(
  tidied: LlmSelection,
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
): string[] {
  const used = tidied.days.flatMap((day) => day.placeIds);
  const free = (id: string) => !used.some((other) => sameStop(other, id, ctx));
  return tidied.days.flatMap((day, index) => {
    if (day.placeIds.length > 0) return [];
    const option = shortlist.options.find((o) => o.anchor.id === day.anchorId);
    const open = (option?.candidates ?? []).filter(
      (c) => c.statuses[index]?.kind !== "closed" && free(c.place.id),
    );
    const ids = open.map((c) => (c.meal ? `${c.place.id} (meal)` : c.place.id));
    const head = `Day ${index + 1} (${day.anchorId}, ${dateOf(request, index)}) has no stops left.`;
    const tail =
      ids.length > 0
        ? `Candidates at ${day.anchorId} open that day and not in the trip: ${ids.join(", ")}.`
        : `No candidate at ${day.anchorId} open that day is free, so move stops to it from other days, or give it another base.`;
    return [`${head} ${tail}`];
  });
}

/** The repair turn's account of what the tidy step did to the answer. */
export function repairNotes(
  tidied: Tidied,
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
): RepairNotes {
  const trip = tidied.selection;
  const removed: string[] = [];
  const moved: string[] = [];
  for (const change of tidied.changes) {
    const { placeId, toDay } = change;
    if (placeId === undefined) continue;
    if (toDay !== undefined) {
      moved.push(`${placeId} from day ${change.day + 1} to day ${toDay + 1}`);
      continue;
    }
    removed.push(
      `day ${change.day + 1}, ${placeId}: ${why({ ...change, placeId }, trip, request, ctx)}`,
    );
  }
  return { removed, moved, emptyDays: emptyDayLines(trip, request, shortlist, ctx) };
}
