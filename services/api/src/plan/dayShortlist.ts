import {
  dayMustIncludes,
  type PlannerContext,
  transferMinutes,
  tripDates,
  twinIds,
  usedOnOtherDays,
} from "@italy/planner";
import { candidatesFor, dayStatus, type Shortlist } from "./candidates";
import type { DayInput } from "./dayInput";

// The candidates the model may choose from for one day of an existing trip: every place of the
// day's base that the whole-trip shortlist would offer on that date (candidatesFor: suggestable,
// within the budget or a meal place one level over, not excluded, open that date, and able to
// fit the day after its transfer), less every place on another day of the trip, every place at
// the same spot as one, and the places the traveler asked to leave out of this version. Code
// enforces it afterwards: an id not offered here is an error (dayMaterialize.ts).

/**
 * The day's shortlist, in the whole-trip Shortlist shape so the tidy step and the repair notes
 * read it as they read a trip's: the trip's dates, one base option, and each candidate's status
 * on every trip date. mustInclude is the day's must-includes that are offered; unplaceable, the
 * rest of them (closed that date, or unable to fit it).
 */
// Decision: every candidate of the base, not a trimmed list. The whole-trip shortlist trims to the
// pace because it offers up to four bases for three days; one day at one base is at most 30 rows
// in the data (Rome), fewer once the other days' places are out, so the model sees everything the
// trip has left there. In 24 live re-plans (2026-09-25) that was 6 to 28 rows and 1,960 to 3,611
// input tokens a call, against about 4,000 to 10,000 for a whole trip.
export function buildDayShortlist(input: DayInput, ctx: PlannerContext): Shortlist {
  const { request, days, day, anchorId } = input;
  const anchor = ctx.anchorById.get(anchorId);
  const dates = tripDates(request.startDate, days.length);
  const date = dates[day];
  if (!anchor || date === undefined) throw new RangeError("The day or its base is not valid");
  const previous = day === 0 ? undefined : ctx.anchorById.get(days[day - 1]?.anchorId ?? "");
  const transferMin = previous ? transferMinutes(previous, anchor) : 0;
  const used = usedOnOtherDays(days, day);
  const must = dayMustIncludes(request, days, day, anchorId, ctx);
  const avoid = new Set(input.avoid.filter((id) => !request.mustInclude.includes(id)));
  const blocked = (id: string) =>
    used.has(id) || avoid.has(id) || twinIds(ctx, id).some((twin) => used.has(twin));
  const candidates = candidatesFor(anchor, request, ctx, [date], transferMin)
    .filter((candidate) => !blocked(candidate.place.id))
    .map((candidate) => ({
      ...candidate,
      mustInclude: must.includes(candidate.place.id),
      statuses: dates.map((other) => dayStatus(candidate.place, other)),
    }));
  const placeIds = new Set(candidates.map((candidate) => candidate.place.id));
  return {
    dates,
    options: candidates.length === 0 ? [] : [{ anchor, candidates }],
    anchorIds: new Set([anchor.id]),
    placeIds,
    mustInclude: must.filter((id) => placeIds.has(id)),
    unplaceable: must.filter((id) => !placeIds.has(id)),
  };
}
