import {
  checkDayBase,
  type DayPlan,
  type DaySelection,
  dayBaseOptions,
  type FallbackReason,
  type Itinerary,
  newTripErrors,
  type PlannerContext,
  type PlanSource,
  placesOfAnchor,
  scheduleTrip,
  TRIP_DAYS,
  travelMode,
  withDay,
} from "@italy/planner";
import { type PlanCallOptions, type PlanDayBody, postPlanDay } from "./api";
import { isApiError } from "./apiError";
import type { PlanDayResponse } from "./apiSchemas";
import { formatDuration, plural, transferText } from "./format";
import { type FallbackCause, fallbackCause } from "./planRequest";

// Changing one day's city, or asking for new ideas for it in its own city, the page's side of
// POST /api/plan/day. The sheet lists every base with the planner's own verdict (dayBaseOptions),
// the API plans the chosen day, and the reducer takes the answer only if it still fits the trip
// on screen (resolveDay); every other case, a failed call included, is planned here by the rules
// with the planner's checkDayBase, the same day the API would fall back to. Model proposes, code
// decides: whatever arrives is timed again in the browser and checked by the validator.

/** What the traveler asked for: day `day` (0-based) planned again at base `anchorId`. */
export interface DayAsk {
  day: number;
  anchorId: string;
  avoid: string[]; // the day's own places for new ideas at its city; empty for another city
}

/** How the call went: the API's day, or why the page plans it here instead. */
export type DayReply =
  | { kind: "answer"; response: PlanDayResponse }
  | { kind: "failed"; cause: FallbackCause };

/** How a day planned again was made, shown under the day's heading (dayClaim). */
export type DayMade =
  | { kind: "api"; source: PlanSource; fallbackReason?: FallbackReason }
  | { kind: "device"; cause: FallbackCause | null };

/** The day to apply, or why none can be. */
export type DayResolution =
  | { kind: "day"; dayPlan: DayPlan; made: DayMade }
  | { kind: "refused"; reason: string };

/** The trip as the API and the planner read it: each day's base and place ids in order. */
export function tripSelection(itinerary: Pick<Itinerary, "days">): DaySelection[] {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

/** One string for the trip's bases and places, to tell whether it changed while a day planned. */
export function tripKey(itinerary: Pick<Itinerary, "days">): string {
  return JSON.stringify(tripSelection(itinerary).map((day) => [day.anchorId, day.placeIds]));
}

/**
 * What the traveler asks for when they choose `anchorId` for day `day`: another city, or the
 * day's own for new ideas, which leaves out the day's current places.
 */
// Decision: new ideas leave out the day's own places, not only the other days' (which every re-plan
// leaves out). The rules are deterministic and the API caches AI days by their input, so the same
// trip at the same city would give the same day back. Only the places on screen now are left out,
// not those of earlier versions, so a small city does not run out after a few presses; a
// must-include is never left out (planDay).
export function dayAsk(itinerary: Itinerary, day: number, anchorId: string): DayAsk {
  const current = itinerary.days[day];
  const same = current?.anchorId === anchorId;
  return { day, anchorId, avoid: same ? (current?.stops.map((stop) => stop.placeId) ?? []) : [] };
}

/** The body of POST /api/plan/day for `ask`, from the trip on screen. */
export function dayRequestBody(itinerary: Itinerary, ask: DayAsk): PlanDayBody {
  return {
    request: itinerary.request,
    days: tripSelection(itinerary).map((day) => ({
      anchorId: day.anchorId,
      ids: [...day.placeIds],
    })),
    day: ask.day,
    anchorId: ask.anchorId,
    ...(ask.avoid.length > 0 ? { avoid: ask.avoid } : {}),
  };
}

export interface DayCallDeps {
  post?: (body: PlanDayBody, options: PlanCallOptions) => Promise<PlanDayResponse>;
}

/**
 * Asks the API for the day. Resolves to its answer or, when the call fails in any way but being
 * cancelled, to why it failed; the reducer then plans the day here. Rethrows a cancellation.
 */
// Decision: every failure falls back, a 400 or 422 included. For a whole trip a refused request is
// the traveler's to fix in the form; here the page built the body from the trip on screen, so a
// refusal can only be a version mismatch, and the planner in this page answers for its own data.
export async function requestDay(
  body: PlanDayBody,
  deps: DayCallDeps = {},
  options: PlanCallOptions = {},
): Promise<DayReply> {
  const post = deps.post ?? postPlanDay;
  try {
    return { kind: "answer", response: await post(body, options) };
  } catch (error) {
    if (isApiError(error) && error.kind === "aborted") throw error;
    return { kind: "failed", cause: fallbackCause(error) };
  }
}

/**
 * The day to apply to `itinerary` for `ask`: the API's day when it fits the trip as it is now
 * (the day and base asked for, known places, none already on another day, and no new error from
 * the validator), or else the rules' day planned here, labelled with why. `basis` is tripKey of
 * the trip the request was sent with. Refused only when the rules cannot plan the day either.
 */
// Decision: the answer is checked against the trip on screen, not the one it was asked for. The
// rest of the trip stays editable while a day plans, so a swap on another day may have taken one
// of its places; then the day is planned here against the trip as it is, and only an answer that
// breaks a rule on the unchanged trip is blamed on the server ("invalid").
export function resolveDay(
  itinerary: Itinerary,
  ask: DayAsk,
  reply: DayReply,
  basis: string,
  ctx: PlannerContext,
): DayResolution {
  if (!itinerary.days[ask.day] || !ctx.anchorById.has(ask.anchorId)) {
    return { kind: "refused", reason: "That day or city is no longer in the plan." };
  }
  const days = tripSelection(itinerary);
  let cause: FallbackCause | null;
  if (reply.kind === "answer") {
    const { response } = reply;
    if (answerFits(itinerary, days, ask, response, ctx)) {
      const reason = response.meta.fallbackReason;
      const made: DayMade = {
        kind: "api",
        source: response.source,
        ...(response.source === "deterministic" && reason ? { fallbackReason: reason } : {}),
      };
      return { kind: "day", dayPlan: response.dayPlan, made };
    }
    cause = basis === tripKey(itinerary) ? "invalid" : null;
  } else {
    cause = reply.cause;
  }
  const { request } = itinerary;
  const check = checkDayBase(request, days, ask.day, ask.anchorId, ctx, { avoid: ask.avoid });
  if (check.day === null) {
    return { kind: "refused", reason: check.option.reason ?? "This day cannot move there." };
  }
  // scheduleTrip times every day it is given, so the day is there.
  const timed = scheduleTrip(request, withDay(days, ask.day, check.day), ctx);
  const dayPlan = timed.days[ask.day] as DayPlan;
  return { kind: "day", dayPlan, made: { kind: "device", cause } };
}

function answerFits(
  itinerary: Itinerary,
  days: readonly DaySelection[],
  ask: DayAsk,
  response: PlanDayResponse,
  ctx: PlannerContext,
): boolean {
  const { dayPlan } = response;
  const ids = dayPlan.stops.map((stop) => stop.placeId);
  if (response.day !== ask.day || dayPlan.anchorId !== ask.anchorId) return false;
  if (dayPlan.date !== itinerary.days[ask.day]?.date || ids.length === 0) return false;
  const others = new Set(days.flatMap((day, index) => (index === ask.day ? [] : day.placeIds)));
  const unique = new Set(ids).size === ids.length;
  if (!unique || ids.some((id) => others.has(id) || !ctx.placesById.has(id))) return false;
  try {
    const day = { anchorId: ask.anchorId, placeIds: ids };
    return newTripErrors(itinerary.request, days, ask.day, day, ctx).length === 0;
  } catch {
    return false; // the validator could not read it, so it cannot be shown as checked
  }
}

/** One base in the Change city sheet. */
export interface CityChoice {
  anchorId: string;
  name: string;
  current: boolean; // the day's city now: choosing it gives new ideas for the day
  allowed: boolean;
  reason: string | null; // why not, when not allowed
  line: string; // the travel it means and how many places the city has, when allowed
}

/**
 * Every base for day `day` (0-based) as the sheet shows it, the day's own first: the planner's
 * verdict (dayBaseOptions) and one factual line. The day's own city is checked for new ideas,
 * that is with its current places left out.
 */
export function cityChoices(itinerary: Itinerary, day: number, ctx: PlannerContext): CityChoice[] {
  const days = tripSelection(itinerary);
  const avoid = days[day]?.placeIds ?? [];
  const options = dayBaseOptions(itinerary.request, days, day, ctx, { avoid });
  return options.map((option) => ({
    anchorId: option.anchorId,
    name: option.name,
    current: option.current,
    allowed: option.allowed,
    reason: option.allowed ? null : (option.reason ?? null),
    line: cityLine(days, day, option, ctx),
  }));
}

/**
 * "2 h 10 min by high-speed train from Rome, 22 places": the travel into the day from the day
 * before's base, the travel on to the next day's base when there is any, and the city's places.
 */
function cityLine(
  days: readonly DaySelection[],
  day: number,
  option: { anchorId: string; transferInMin: number; transferOutMin: number },
  ctx: PlannerContext,
): string {
  const here = ctx.anchorById.get(option.anchorId);
  const before = ctx.anchorById.get(days[day - 1]?.anchorId ?? "");
  const after = ctx.anchorById.get(days[day + 1]?.anchorId ?? "");
  const parts: string[] = [];
  if (here && before) {
    parts.push(
      option.transferInMin > 0
        ? transferText(
            option.transferInMin,
            travelMode(before.centroid, here.centroid),
            before.name,
          )
        : `Same city as day\u00a0${day}`,
    );
  }
  if (after && option.transferOutMin > 0) {
    // No break inside "day 3": a line that ends on "day" reads as a sentence cut short.
    parts.push(
      `${formatDuration(option.transferOutMin)} on to ${after.name} for day\u00a0${day + 2}`,
    );
  }
  parts.push(plural(placesOfAnchor(ctx, option.anchorId).length, "place", "places"));
  return parts.join(", ");
}

/** "Planned again with AI" and the rest: how a day planned again was made, in the source line's words. */
export function dayClaim(made: DayMade): { claim: string; ai: boolean } {
  if (made.kind === "device") {
    const claim = made.cause ? DEVICE_DAY_CLAIM[made.cause] : "Planned again on this device";
    return { claim, ai: false };
  }
  if (made.source === "ai") return { claim: "Planned again with AI", ai: true };
  if (made.source === "ai_repaired") {
    return { claim: "Planned again with AI, fixed after a check", ai: true };
  }
  const reason = made.fallbackReason;
  return { claim: reason ? RULES_DAY_CLAIM[reason] : "Planned again without AI", ai: false };
}

// Decision: the source line's own words (lib/sourceText.ts) with "again", so a traveler who has
// read what the trip's line means reads the day's line the same way.
const RULES_DAY_CLAIM: Record<FallbackReason, string> = {
  requested: "Planned again without AI",
  no_key: "Planned again without AI: the AI planner is off",
  disabled: "Planned again without AI: the AI planner is off",
  timeout: "Planned again without AI: the AI planner timed out",
  rate_limited: "Planned again without AI: the AI planner was busy",
  refusal: "Planned again without AI: the AI planner declined",
  invalid_after_repair: "Planned again without AI: the AI's plan broke a rule",
  schema_invalid: "Planned again without AI: the AI planner failed",
  max_tokens: "Planned again without AI: the AI planner failed",
  llm_error: "Planned again without AI: the AI planner failed",
  offline: "Planned again without AI: the server was unreachable",
};

const DEVICE_DAY_CLAIM: Record<FallbackCause, string> = {
  offline: "Planned again on this device, offline",
  timeout: "Planned again on this device: the server timed out",
  busy: "Planned again on this device: the server was busy",
  server: "Planned again on this device: the server failed",
  unreadable: "Planned again on this device: the reply was unreadable",
  invalid: "Planned again on this device: the server's day broke a rule",
};

/** "Day 2 now in Florence." or "New ideas for day 2.", with how it was planned when not by AI. */
export function dayMessage(day: number, name: string, moved: boolean, made: DayMade): string {
  const head = moved ? `Day ${day + 1} now in ${name}.` : `New ideas for day ${day + 1}.`;
  if (made.kind === "device") return `${head} Planned without AI on this device.`;
  return made.source === "deterministic" ? `${head} Planned without AI.` : head;
}

/** A fresh record of how each day was made: none planned again yet. */
export function noDaysMade(): (DayMade | null)[] {
  return Array.from({ length: TRIP_DAYS }, () => null);
}

/**
 * The days (1-based) whose AI why lines a saved trip leaves out: days planned again by the AI
 * that still show one. A saved trip takes the AI's words only from the AI plan on record, and a
 * day planned again has none (services/api/src/trips/rebuild.ts), so it shows the rules' there.
 */
export function replannedAiDays(
  itinerary: Pick<Itinerary, "days">,
  made: readonly (DayMade | null)[],
): number[] {
  return itinerary.days.flatMap((day, index) => {
    const how = made[index];
    const ai = how?.kind === "api" && how.source !== "deterministic";
    return ai && day.stops.some((stop) => stop.reasonSource === "ai") ? [index + 1] : [];
  });
}
