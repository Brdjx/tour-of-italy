import { type PlannerContext, REASON_MAX_CHARS, type Stop } from "@italy/planner";
import type { LlmSelection } from "../llm/client";
import { namesPlaceOutside, unknownProperNoun } from "./placeMentions";
import { type ClaimKind, contradictedClaim, type TimedDay } from "./reasonClaims";
import {
  cleanText,
  echoesPrompt,
  hasContactOrPayment,
  hasMarkupOrInjection,
  statesTimeOrPrice,
} from "./textGuards";

// AI reasons are kept only when they pass every check below, and when what they say about the
// stop's meal, time of day and place in the day or trip holds for the stop as timed
// (reasonClaims.ts); otherwise the stop keeps the rule-based reason the planner already attached
// (ruleReason, reasonSource "rule").

export type ReasonRejection =
  | "empty"
  | "too_long"
  | "names_other_place"
  | "unknown_name"
  | "time_or_price"
  | "contact_or_payment"
  | "markup_or_injection"
  | "echoes_prompt"
  | "wrong_meal"
  | "wrong_time_of_day"
  | "wrong_position";

/** The log's name for each kind of claim the timed stop contradicts. */
const CLAIM_REJECTIONS: Record<ClaimKind, ReasonRejection> = {
  meal: "wrong_meal",
  time_of_day: "wrong_time_of_day",
  position: "wrong_position",
};

export type ReasonCheck = { ok: true; text: string } | { ok: false; why: ReasonRejection };

/**
 * Checks one AI reason for one stop. Rejected when empty, longer than REASON_MAX_CHARS, containing
 * markup, injection phrases, contact or payment details, stating a time, duration, hours, or
 * price, repeating the prompt, naming another dataset place, or using a proper noun the dataset
 * never mentions.
 */
export function checkAiReason(raw: string, placeId: string, ctx: PlannerContext): ReasonCheck {
  const text = cleanText(raw);
  if (text === "") return { ok: false, why: "empty" };
  if (text.length > REASON_MAX_CHARS) return { ok: false, why: "too_long" };
  if (hasMarkupOrInjection(text)) return { ok: false, why: "markup_or_injection" };
  if (hasContactOrPayment(text)) return { ok: false, why: "contact_or_payment" };
  if (statesTimeOrPrice(text)) return { ok: false, why: "time_or_price" };
  if (echoesPrompt(text)) return { ok: false, why: "echoes_prompt" };
  // Decision: a name that is part of this stop's own name is not "another place": a reason for
  // "Trevi Fountain by Night" may say "Trevi Fountain".
  if (namesPlaceOutside(text, new Set([placeId]), ctx))
    return { ok: false, why: "names_other_place" };
  if (unknownProperNoun(text, ctx) !== null) return { ok: false, why: "unknown_name" };
  return { ok: true, text };
}

/** Reasons from the selection by day and place id; the first reason for a place wins. */
function reasonsByStop(selection: LlmSelection): Map<string, string>[] {
  return selection.days.map((day) => {
    const byId = new Map<string, string>();
    for (const entry of day.reasons)
      if (!byId.has(entry.placeId)) byId.set(entry.placeId, entry.reason);
    return byId;
  });
}

export interface ReasonStats {
  kept: number;
  replaced: number;
  rejections: ReasonRejection[]; // why each replaced reason was dropped, for the log line
}

/**
 * Stops with AI reasons applied where they pass checkAiReason and make no claim the timed stop
 * contradicts (contradictedClaim). Stops without a usable AI reason keep the rule reason already
 * on them. Returns new stop arrays; the input is not changed.
 */
export function applyAiReasons(
  days: readonly TimedDay[],
  selection: LlmSelection,
  ctx: PlannerContext,
): { days: Stop[][]; stats: ReasonStats } {
  const byDay = reasonsByStop(selection);
  const stats: ReasonStats = { kept: 0, replaced: 0, rejections: [] };
  const out = days.map((day, dayIndex) =>
    day.stops.map((stop, index) => {
      const raw = byDay[dayIndex]?.get(stop.placeId);
      if (raw === undefined) {
        stats.replaced++;
        stats.rejections.push("empty");
        return { ...stop };
      }
      const check = checkAiReason(raw, stop.placeId, ctx);
      if (!check.ok) {
        stats.replaced++;
        stats.rejections.push(check.why);
        return { ...stop };
      }
      const claim = contradictedClaim(check.text, { days, day: dayIndex, index }, ctx);
      if (claim !== null) {
        stats.replaced++;
        stats.rejections.push(CLAIM_REJECTIONS[claim.kind]);
        return { ...stop };
      }
      stats.kept++;
      return { ...stop, reason: check.text, reasonSource: "ai" as const };
    }),
  );
  return { days: out, stats };
}
