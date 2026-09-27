import {
  checkDayBase,
  type DayBaseOption,
  type DayPlan,
  type DayRefusal,
  type DaySelection,
  type Itinerary,
  mustIncludesLeftOut,
  newTripErrors,
  type OtherDayNote,
  type PlannerContext,
  placesOfAnchor,
  planRoute,
  type ReplanWhy,
  type RoutePlan,
  routeOptions,
  routeStartDays,
  scheduleTrip,
  type TripRequest,
  withDay,
} from "@italy/planner";
import type { PlanDayBody } from "./api";
import type { PlanDayResponse } from "./apiSchemas";
import { type DayMade, type DayReply, tripKey, tripSelection } from "./dayCity";
import { formatClock, formatDuration, plural, shortDate } from "./format";
import type { FallbackCause } from "./planRequest";

// A route set by hand, the page's side of decision 16: a city for each day, chosen in the route
// sheet (components/RouteSheet.tsx), planned a day at a time through POST /api/plan/day, and put
// in as one edit. The planner says what a route means (planRoute: which days are planned again
// and why, the travel as facts, the rare refusal with its way out); this file turns that into
// what the sheet and the board show, builds each request from the trip as planned so far, and
// takes an answer only when it fits that trip, planning the day here with the rules otherwise.
// New ideas for one day in its own city runs the same way, as a run of one day with no route.

/** One day of a run: the day, its city, and places to leave out (new ideas only). */
export interface DayJob {
  day: number; // 0-based
  anchorId: string;
  avoid: string[];
  why: ReplanWhy | "ideas";
}

/** What a run changes, for its message and its Undo label. */
export type ReplanKind = "ideas" | "city" | "route";

/** The days to plan, in order, and what to send with the first. */
export interface ReplanRun {
  kind: ReplanKind;
  route: string[] | null; // the route every request carries; null for new ideas
  jobs: DayJob[]; // in day order
  names: string[]; // each job's city name
  start: DaySelection[]; // the trip to send first (routeStartDays)
  basis: string; // tripKey of the trip on screen when the run began
  head: string; // "Day 2 now in Florence.", "Route changed: ...", "New ideas for day 2."
}

/** A day of a run, planned. */
export interface ReplannedResult {
  day: number;
  dayPlan: DayPlan;
  made: DayMade;
}

/** A day of a run as the page resolved it, or why it cannot be planned at all. */
export type JobResolution =
  | { kind: "day"; dayPlan: DayPlan; made: DayMade }
  | { kind: "refused"; reason: string };

/** "Day 2" */
export function dayTitle(day: number): string {
  return `Day ${day + 1}`;
}

/** "Day 3", "Days 2 and 3", "Days 1, 2 and 3", for 0-based days in order. */
export function daysTitle(days: readonly number[]): string {
  const numbers = days.map((day) => day + 1);
  if (numbers.length < 2) return `Day ${numbers[0] ?? ""}`;
  return `Days ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

/** Each day's city in the trip as it is: the route the sheet starts from. */
export function tripRoute(itinerary: Pick<Itinerary, "days">): string[] {
  return itinerary.days.map((day) => day.anchorId);
}

/** True when `draft` gives every day the city it has now. */
export function sameRoute(itinerary: Pick<Itinerary, "days">, draft: readonly string[]): boolean {
  return itinerary.days.every((day, index) => day.anchorId === draft[index]);
}

/** One day in the route view. */
export interface RouteRow {
  day: number;
  date: string; // "Sat 10 Oct"
  start: string; // when its places can start, after any travel in ("11:40")
  anchorId: string;
  name: string;
  was: string | null; // the day's city now, when the route changes it
  legIn: string | null; // the travel into the day ("2 h 10 min by high-speed train", "Same city")
  note: string | null; // what happens to a day kept in its city ("Day 3 will be planned again: ...")
  facts: string[]; // what its travel leaves of it and the meals it cannot have, on a day the route changes or retimes
  replan: boolean; // planned again
  refusal: string | null; // why the route cannot be planned, and the way out
}

/** The route view: every day, what the route does, and its one action. */
export interface RouteView {
  plan: RoutePlan;
  rows: RouteRow[];
  changed: boolean;
  allowed: boolean;
  action: string; // "Plan day 2 and day 3"
  travel: string | null; // "Travel between cities: 4 h 10 min"
}

/**
 * What the route sheet shows for `draft`: each day with its start, its city, the city it
 * replaces, the travel into it, what happens to it and what the travel leaves of it, and the
 * action that plans it. Throws RangeError on a draft that is not a known base for every day
 * (planRoute).
 */
// Decision: each fact once (design review, 2026-09-26). The board already says a day's travel on
// the leg above it and its start in the day's column, so a day the route touches keeps only what
// the travel leaves of it ("Leaves about 7 h before dinner.", dayTravel's second fact). A day
// whose city changes has no note: "Florence, was Rome" says it, and "Day 1 will be planned in
// Florence." under it said it again and pushed its facts down. A day kept in its city still says
// what happens to it (planned again for its travel or to hold a place asked for, or kept at a new
// start). A day the route leaves as it is shows no facts. A meal no place of the day's city can
// take that date is a fact too (decision 17: "No dinner place listed for Bologna opens on
// Mondays."), said before the day is planned, as its travel is.
export function routeView(
  itinerary: Itinerary,
  draft: readonly string[],
  ctx: PlannerContext,
): RouteView {
  const plan = planRoute(itinerary.request, tripSelection(itinerary), draft, ctx);
  const rows = plan.days.map((day): RouteRow => {
    const now = itinerary.days[day.day]?.anchorId;
    const touched = day.changes || day.replan !== null || day.note !== null;
    const refusal = plan.refusal?.day === day.day ? plan.refusal : null;
    return {
      day: day.day,
      date: shortDate(itinerary.days[day.day]?.date ?? ""),
      start: formatClock(day.startMin),
      anchorId: day.anchorId,
      name: day.name,
      was: day.changes ? (ctx.anchorById.get(now ?? "")?.name ?? null) : null,
      legIn: day.day === 0 ? null : (day.travelIn?.label ?? "Same city"),
      note: day.changes ? null : day.note,
      facts: touched ? [...travelFacts(day.warnings, day.meals).slice(1), ...day.meals] : [],
      replan: day.replan !== null,
      refusal: refusal ? `${refusal.reason} ${refusal.fix}` : null,
    };
  });
  return {
    plan,
    rows,
    changed: plan.changed,
    allowed: plan.allowed,
    action: planAction(plan.replan),
    travel: plan.travelMin > 0 ? `Travel between cities: ${formatDuration(plan.travelMin)}` : null,
  };
}

/**
 * A day's travel facts (dayTravel: the train and when the day starts, then what it leaves before
 * dinner), without the second when `meals` (mealFacts) says the day has no dinner to have.
 */
// Decision: "Leaves about 7 h before dinner." and "No dinner place listed for Bologna opens on
// Mondays." together read as a contradiction, and the owner's day 3 showed the first over a day
// with no dinner. The start the first line gives says what the travel takes; the day's board drops
// it the same way. Every dinner fact starts "No dinner place" (mealFacts says so).
export function travelFacts(travel: readonly string[], meals: readonly string[]): string[] {
  return meals.some((fact) => fact.startsWith("No dinner place"))
    ? travel.slice(0, 1)
    : [...travel];
}

/** "Plan day 2", "Plan day 2 and day 3", "Plan all three days": the route sheet's action. */
export function planAction(days: readonly number[]): string {
  if (days.length >= 3) return "Plan all three days";
  return `Plan ${days.map((day) => `day ${day + 1}`).join(" and ")}`;
}

/** A city in a day's list. */
export interface CityRow {
  anchorId: string;
  name: string;
  planned: boolean; // the day's city in the trip now
  chosen: boolean; // the day's city in the route being set
  allowed: boolean;
  line: string; // how the day meets its neighbours, and the city's places
  warnings: string[]; // the day's travel and the meals it cannot have as facts, and what else the choice plans again
  reason: string | null; // why not, and the way out, when not allowed
}

/** A day's list of cities, and New ideas for it. */
export interface DayChoices {
  day: number;
  rows: CityRow[]; // the trip's city for the day first
  ideas: { allowed: boolean; reason: string | null };
}

/**
 * The short form of a reason that is the same whatever the city, for every row after the first
 * that gives it (dayChoices).
 */
// Decision: said in full once, on the first row that has it, and short on the rows after, so a
// list where every other city is refused for the same place does not read one long sentence four
// times. Every row still says why (a reason is never hidden), and a reason that names the city
// (nothing fitting there) stays whole on every row.
export const SHORT_REASONS: Partial<Record<DayRefusal, string>> = {
  holds_must_include: "This day has a place you asked for.",
};

/**
 * The short form of `option`'s reason in day `day`'s list (SHORT_REASONS), naming the day that
 * holds the place when it is another day; undefined when the reason has no short form.
 */
// Decision: found in review (2026-09-26). In a route being set the place can be on another day:
// with Rome three days, the Colosseum on day 1 and day 1 set to Florence, every other city for
// day 2 loses it, and "This day has a place you asked for." on day 2's list named the wrong day.
function shortReason(option: DayBaseOption, day: number): string | undefined {
  const short = option.refusal ? SHORT_REASONS[option.refusal] : undefined;
  const holder = option.refusalDay ?? day;
  if (short === undefined || holder === day) return short;
  return short.replace("This day", `Day ${holder + 1}`);
}

/** Said beside New ideas while the route being set has changes. */
export const IDEAS_WAIT = "Your route has changes. Plan them or reset it first.";

/**
 * Every base for day `day` of the route being set (`draft`), as the day's list shows it: the
 * trip's city for the day first, each with the planner's verdict for the draft with that day's
 * city changed (routeOptions). A city's warnings leave out what the draft already does to the
 * other days, so each says only what choosing it adds, and say the travel on to the next day
 * once (otherNote). New ideas is checked as a new version of the day in its own city with its
 * places left out (checkDayBase), and waits while the draft has changes, since a day of new
 * ideas is planned alone. Throws RangeError on a day out of range.
 */
export function dayChoices(
  itinerary: Itinerary,
  draft: readonly string[],
  day: number,
  ctx: PlannerContext,
): DayChoices {
  const { request } = itinerary;
  const days = tripSelection(itinerary);
  const draftPlan = planRoute(request, days, draft, ctx);
  const known = new Set(
    draftPlan.days.flatMap((other) => (other.day !== day && other.note ? [other.note] : [])),
  );
  const said = new Set<string>(); // the full reasons already given on a row above
  const rows = routeOptions(request, days, draft, day, ctx).map((option): CityRow => {
    const full = `${option.reason ?? ""} ${option.fix ?? ""}`.trim();
    const short = said.has(full) ? shortReason(option, day) : undefined;
    if (option.refusal) said.add(full);
    // The day's own travel facts come first, then its meals; the other days' notes end the
    // warnings.
    const travel = option.warnings.slice(
      0,
      option.warnings.length - option.meals.length - option.others.length,
    );
    const own = [...travelFacts(travel, option.meals), ...option.meals];
    const others = option.others
      .filter((other) => !known.has(other.note))
      .map((other) => otherNote(other, day, option));
    return {
      anchorId: option.anchorId,
      name: option.name,
      planned: option.current,
      chosen: draft[day] === option.anchorId,
      allowed: option.allowed,
      line: neighbourLine(draft, day, option, ctx),
      warnings: [...own, ...others],
      reason: option.allowed ? null : (short ?? full),
    };
  });
  const own = days[day] as DaySelection;
  const check = checkDayBase(request, days, day, own.anchorId, ctx, { avoid: own.placeIds });
  const changed = !sameRoute(itinerary, draft);
  const ideas = changed
    ? { allowed: false, reason: IDEAS_WAIT }
    : { allowed: check.option.allowed, reason: check.option.reason ?? null };
  return { day, rows, ideas };
}

/**
 * What choosing a city for day `day` does to another day, as a warning in the day's list: the
 * planner's note, or only "Day 3 will be planned again." for the next day planned again for its
 * travel, since the city's line above it already gives that travel ("2 h 10 min on to Rome for
 * day 3").
 */
// Decision: the minutes once (design review, 2026-09-26). Every city in a day's list said them
// twice, on its line and in the next day's warning ("Day 2 will be planned again: it now starts
// after 2 h 10 min of travel."). The line keeps them, since it says them for every city, the
// next day planned again or not.
function otherNote(
  other: OtherDayNote,
  day: number,
  option: Pick<DayBaseOption, "transferOutMin">,
): string {
  const next = other.day === day + 1 && other.replan === "travel" && option.transferOutMin > 0;
  return next ? `${dayTitle(other.day)} will be planned again.` : other.note;
}

/**
 * "Same city as day 3, 22 places" or "2 h 10 min on to Venice for day 3, 18 places": how a city
 * for day `day` meets the days either side in `route` (the same city as the day before or after,
 * or the travel on to the next), and how many places it has. The travel into the day is one of
 * its warnings, with when the day then starts.
 */
function neighbourLine(
  route: readonly string[],
  day: number,
  option: Pick<DayBaseOption, "anchorId" | "transferOutMin">,
  ctx: PlannerContext,
): string {
  const same: number[] = []; // the neighbouring days (1-based) in this city
  if (route[day - 1] === option.anchorId) same.push(day);
  if (route[day + 1] === option.anchorId) same.push(day + 2);
  const parts: string[] = [];
  if (same.length > 0) parts.push(sameCityText(same));
  const after = ctx.anchorById.get(route[day + 1] ?? "");
  if (after && option.transferOutMin > 0) {
    parts.push(
      `${formatDuration(option.transferOutMin)} on to ${after.name} for day\u00a0${day + 2}`,
    );
  }
  parts.push(plural(placesOfAnchor(ctx, option.anchorId).length, "place", "places"));
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** "same city as day 3", or "same city as days 1 and 3". */
function sameCityText(days: readonly number[]): string {
  // No break inside "day 3": a line that ends on "day" reads as a sentence cut short.
  const [first, second] = days;
  return second === undefined
    ? `same city as day\u00a0${first}`
    : `same city as days\u00a0${first} and\u00a0${second}`;
}

/** The run that plans route `plan` for `itinerary`: its days in day order, with the route. */
export function routeRun(itinerary: Itinerary, plan: RoutePlan, ctx: PlannerContext): ReplanRun {
  const moved = plan.days.filter((day) => day.changes).length;
  const jobs = plan.replan.map(
    (day): DayJob => ({
      day,
      anchorId: plan.route[day] as string,
      avoid: [],
      why: plan.days[day]?.replan ?? "city",
    }),
  );
  return {
    kind: moved > 1 ? "route" : "city",
    route: [...plan.route],
    jobs,
    names: jobs.map((job) => ctx.anchorById.get(job.anchorId)?.name ?? job.anchorId),
    start: routeStartDays(tripSelection(itinerary), plan),
    basis: tripKey(itinerary),
    head: plan.message,
  };
}

/**
 * The run for new ideas on day `day` in its own city: one day, with its places left out, and no
 * route. The other days go as they are.
 */
// Decision: new ideas leave out the day's own places, not only the other days' (which every
// re-plan leaves out). The rules are deterministic and the API caches AI days by their input, so
// the same trip at the same city would give the same day back. Only the places on screen now are
// left out, so a small city does not run out after a few presses; a must-include is never left
// out (planDay).
export function ideasRun(itinerary: Itinerary, day: number, ctx: PlannerContext): ReplanRun {
  const days = tripSelection(itinerary);
  const own = days[day] as DaySelection;
  return {
    kind: "ideas",
    route: null,
    jobs: [{ day, anchorId: own.anchorId, avoid: [...own.placeIds], why: "ideas" }],
    names: [ctx.anchorById.get(own.anchorId)?.name ?? own.anchorId],
    start: days,
    basis: tripKey(itinerary),
    head: `New ideas for day ${day + 1}.`,
  };
}

/** The body of POST /api/plan/day for one job, with the trip as planned so far. */
export function jobBody(
  request: TripRequest,
  working: readonly DaySelection[],
  job: DayJob,
  route: readonly string[] | null,
): PlanDayBody {
  return {
    request,
    days: working.map((day) => ({ anchorId: day.anchorId, ids: [...day.placeIds] })),
    day: job.day,
    anchorId: job.anchorId,
    ...(job.avoid.length > 0 ? { avoid: [...job.avoid] } : {}),
    ...(route ? { route: [...route] } : {}),
  };
}

/**
 * The day to put in for `job`, given how its call went: the API's day when it fits the trip as
 * planned so far (`working`: the days before it planned, the later ones of the run still empty),
 * or else the rules' day planned here (checkDayBase, the day the API itself falls back to),
 * labelled with why. Refused only when the rules cannot plan the day either.
 */
// Decision: every answer is checked against the trip it was asked for, not trusted: the day and
// city asked for, its date, known places, none on another day, no new error from the validator
// (newTripErrors, which judges a later day still waiting in its own turn), and every place asked
// for that the rules' day there holds (mustIncludesLeftOut). A day that fails is planned here and
// blamed on the server ("invalid"), since editing waits while a run plans and the trip cannot
// have changed under it.
export function resolveJob(
  itinerary: Itinerary,
  working: readonly DaySelection[],
  job: DayJob,
  reply: DayReply,
  ctx: PlannerContext,
): JobResolution {
  const { request } = itinerary;
  const check = checkDayBase(request, working, job.day, job.anchorId, ctx, { avoid: job.avoid });
  let cause: FallbackCause;
  let failedOn: number | undefined;
  if (reply.kind === "answer") {
    const { response } = reply;
    if (answerFits(itinerary, working, job, response, check.day, ctx)) {
      const reason = response.meta.fallbackReason;
      const made: DayMade = {
        kind: "api",
        source: response.source,
        ...(response.source === "deterministic" && reason ? { fallbackReason: reason } : {}),
      };
      return { kind: "day", dayPlan: response.dayPlan, made };
    }
    cause = "invalid";
  } else {
    cause = reply.cause;
    failedOn = reply.failedOn;
  }
  if (check.day === null) {
    return { kind: "refused", reason: check.option.reason ?? "This day cannot be planned there." };
  }
  // scheduleTrip times every day it is given, so the day is there.
  const timed = scheduleTrip(request, withDay(working, job.day, check.day), ctx);
  const made: DayMade = { kind: "device", cause, ...(failedOn === undefined ? {} : { failedOn }) };
  return { kind: "day", dayPlan: timed.days[job.day] as DayPlan, made };
}

function answerFits(
  itinerary: Itinerary,
  working: readonly DaySelection[],
  job: DayJob,
  response: PlanDayResponse,
  rulesDay: DaySelection | null,
  ctx: PlannerContext,
): boolean {
  const { dayPlan } = response;
  const ids = dayPlan.stops.map((stop) => stop.placeId);
  if (response.day !== job.day || dayPlan.anchorId !== job.anchorId) return false;
  if (dayPlan.date !== itinerary.days[job.day]?.date || ids.length === 0) return false;
  const others = new Set(working.flatMap((day, index) => (index === job.day ? [] : day.placeIds)));
  const unique = new Set(ids).size === ids.length;
  if (!unique || ids.some((id) => others.has(id) || !ctx.placesById.has(id))) return false;
  try {
    const day = { anchorId: job.anchorId, placeIds: ids };
    const { request } = itinerary;
    const lost = rulesDay ? mustIncludesLeftOut(request, job.day, rulesDay, day, ctx) : [];
    return lost.length === 0 && newTripErrors(request, working, job.day, day, ctx).length === 0;
  } catch {
    return false; // the validator could not read it, so it cannot be shown as checked
  }
}

/** True for a day planned by the AI (as written, or fixed after a check). */
function byAi(made: DayMade): boolean {
  return made.kind === "api" && made.source !== "deterministic";
}

/**
 * The message for a finished run, for the toast and the live region: its head ("Day 2 now in
 * Florence.", "Route changed: Rome, Florence, Venice.", "New ideas for day 2."), the days
 * planned again only for their travel or a place asked for ("Day 3 planned again."), and which
 * days the AI did not plan ("Planned without AI on this device.", "Day 3 planned without AI.").
 */
export function replanMessage(run: ReplanRun, results: readonly ReplannedResult[]): string {
  const parts = [run.head];
  const again = run.jobs.filter((job) => job.why === "travel" || job.why === "must_include");
  if (again.length > 0) parts.push(`${daysTitle(again.map((job) => job.day))} planned again.`);
  const rules = results.filter((result) => !byAi(result.made));
  if (rules.length > 0) {
    const device = rules.every((result) => result.made.kind === "device");
    const where = device ? " on this device" : "";
    parts.push(
      rules.length === results.length
        ? `Planned without AI${where}.`
        : `${daysTitle(rules.map((result) => result.day))} planned without AI${where}.`,
    );
  }
  return parts.join(" ");
}

/** "Planning day 2 in Florence (1 of 2)", or "Planning new ideas for day 2". */
export function planningText(
  run: Pick<ReplanRun, "kind" | "jobs" | "names">,
  step: number,
): string {
  const job = run.jobs[step];
  if (!job) return "";
  if (run.kind === "ideas") return `Planning new ideas for day ${job.day + 1}`;
  const of = run.jobs.length > 1 ? ` (${step + 1} of ${run.jobs.length})` : "";
  return `Planning day ${job.day + 1} in ${run.names[step] ?? ""}${of}`;
}

/** "Waiting to plan day 3 in Venice (2 of 2)": a later day of a run, still to come. */
export function waitingText(run: Pick<ReplanRun, "jobs" | "names">, step: number): string {
  const job = run.jobs[step];
  if (!job) return "";
  return `Waiting to plan day ${job.day + 1} in ${run.names[step] ?? ""} (${step + 1} of ${run.jobs.length})`;
}

/**
 * "Editing waits until day 2 and day 3 are planned.": said on the other days while a run plans,
 * naming the days still to come from `step` on.
 */
export function lockedText(run: Pick<ReplanRun, "jobs">, step: number): string {
  const days = run.jobs.slice(step).map((job) => `day ${job.day + 1}`);
  const list =
    days.length < 2 ? (days[0] ?? "") : `${days.slice(0, -1).join(", ")} and ${days.at(-1)}`;
  return `Editing waits until ${list} ${days.length < 2 ? "is" : "are"} planned.`;
}
