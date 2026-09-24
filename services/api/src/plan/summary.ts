import { type PlannerContext, SUMMARY_MAX_CHARS } from "@italy/planner";
import { namesPlaceOutside, unknownProperNoun } from "./placeMentions";
import {
  cleanText,
  echoesPrompt,
  hasContactOrPayment,
  hasMarkupOrInjection,
  statesTimeOrPrice,
} from "./textGuards";

// The AI summary, cleaned sentence by sentence. A sentence is dropped when it is a fragment,
// states a time, hours, or price, contains markup, injection phrases, or contact details, repeats
// the prompt, names a dataset place that is not in the plan, or uses a proper noun the dataset
// never mentions. What is left is cut to whole sentences within SUMMARY_MAX_CHARS. Nothing left,
// no summary.

// Decision: no exemption for sentences that explain a skip ("X was left out"). Wording such as
// "no rush" or "not to be missed" made any exemption easy to trip, and the rule reasons and the
// plan warnings already explain what was left out.

const MIN_SENTENCE_WORDS = 3;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Why a sentence is dropped, or null to keep it. Exported for tests. */
export function summarySentenceProblem(
  sentence: string,
  planPlaceIds: ReadonlySet<string>,
  ctx: PlannerContext,
): string | null {
  // Decision: a "sentence" under three words ("Rules: 1.") is a fragment of something else, most
  // often a list the model copied, never a useful summary.
  if (sentence.split(/\s+/).length < MIN_SENTENCE_WORDS) return "fragment";
  if (hasMarkupOrInjection(sentence)) return "markup_or_injection";
  if (hasContactOrPayment(sentence)) return "contact_or_payment";
  if (statesTimeOrPrice(sentence)) return "time_or_price";
  if (echoesPrompt(sentence)) return "echoes_prompt";
  if (namesPlaceOutside(sentence, planPlaceIds, ctx)) return "names_place_not_in_plan";
  if (unknownProperNoun(sentence, ctx) !== null) return "unknown_name";
  return null;
}

/** The cleaned summary, or undefined when nothing usable is left. */
export function sanitizeSummary(
  raw: string,
  planPlaceIds: ReadonlySet<string>,
  ctx: PlannerContext,
): string | undefined {
  const kept: string[] = [];
  let length = 0;
  for (const sentence of splitSentences(cleanText(raw))) {
    if (summarySentenceProblem(sentence, planPlaceIds, ctx) !== null) continue;
    const added = length === 0 ? sentence.length : length + 1 + sentence.length;
    // Decision: whole sentences only. A sentence cut mid-way reads as a bug in the UI.
    if (added > SUMMARY_MAX_CHARS) break;
    kept.push(sentence);
    length = added;
  }
  return kept.length === 0 ? undefined : kept.join(" ");
}
