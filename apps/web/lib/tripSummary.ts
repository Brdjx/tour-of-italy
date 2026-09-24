import { addDays, isValidIsoDate, TRIP_DAYS, type TripRequest } from "@italy/planner";
import { plural, shortDate } from "./format";
import { requestOptionCount } from "./moreOptions";

// The one line the trip form folds into once a plan is on screen (or on its way):
// "Thu 15 Oct to Sat 17 Oct, balanced pace, 2 options". It describes the request behind the plan,
// not unsent changes in the form, so it always matches the timetable below it.

/** "Thu 15 Oct to Sat 17 Oct": the trip's first and last day. */
export function tripDateRange(startDate: string, tripDays: number = TRIP_DAYS): string {
  // Decision: total, like every formatter the page renders with. A request is schema-checked
  // before it gets here, but a throw inside render would blank the whole page.
  if (!isValidIsoDate(startDate) || !Number.isInteger(tripDays) || tripDays < 1) return startDate;
  const first = shortDate(startDate);
  if (tripDays === 1) return first;
  return `${first} to ${shortDate(addDays(startDate, tripDays - 1))}`;
}

/** The summary line for a request. Options are counted by group (see moreOptions.ts). */
export function tripSummaryText(request: TripRequest, tripDays: number = TRIP_DAYS): string {
  const parts = [tripDateRange(request.startDate, tripDays), `${request.pace} pace`];
  const count = requestOptionCount(request);
  if (count > 0) parts.push(plural(count, "option", "options"));
  return parts.join(", ");
}
