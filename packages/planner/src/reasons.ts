import { REASON_MAX_CHARS } from "./config";
import { coversMeal } from "./constraints";
import { type LatLng, travelMode } from "./travel";
import type { Meal, Place, Stop, StopRole, TripRequest } from "./types";

// Rule-based reasons: one short line per stop that says why the rules picked it, built only from
// the place's own data and the request. Used by the deterministic planner, and in place of any AI
// reason the API drops. The caller sets reasonSource: "rule".
// Decision: rule reasons never contain clock times, durations, prices, or another place's name,
// so they pass the same sanitizer as AI reasons and can never be dropped in a loop.
// Decision: a rule reason never opens with what the row above it prints: the meal label, the
// type and the area ("Dinner in Ostiense.", "Museum in Borgo." are gone). What it says is the
// request (asked for, interests), the tags the score rewards, worded as what the data lists
// ("Listed as a local favorite.", never "A local favorite." as if it were our opinion), the
// rating, and for a meal a walk from the previous stop. The page drops the rating sentence
// where the row prints the rating (lib/reasonText.ts), and keeps it where it does not (the swap
// sheet).

/** Said when nothing new is left. The page hides these; the field is never empty. */
const FALLBACK: Record<StopRole, string> = {
  visit: "Suggested stop.",
  lunch: "Lunch stop.",
  dinner: "Dinner stop.",
};

/** Most matched interests named in one reason, so the sentence stays short. */
const MAX_NAMED_INTERESTS = 3;

/**
 * Tags the score rewards on their own (score.ts), in the order a reason names them, with the
 * words after "Listed as".
 */
// Decision: only these two. They are why the rules rank a place without any interest chosen, so
// naming them is the honest answer to "why this stop". Other tags (hidden gem, romantic) move no
// score and would read as a recommendation the planner never made.
const LISTED_TAGS: readonly { tag: string; words: string }[] = [
  { tag: "iconic", words: "iconic" },
  { tag: "local-favorite", words: "a local favorite" },
];

/** The place fields a reason reads. */
export type ReasonPlace = Pick<Place, "id" | "rating" | "tags" | "lat" | "lng">;

/**
 * A reason built only from data, at most REASON_MAX_CHARS long and never empty. Sentences are
 * added in priority order while they fit; a sentence too long for the limit (a very long tag, say)
 * is skipped rather than cut mid-word.
 *
 * "You asked to include this." when must-include; "Matches your interest in food and wine.";
 * "Listed as iconic and a local favorite."; "Rated 4.8 out of 5." A lunch or dinner opens with
 * "Close to your previous stop." when that stop is a walk away. When none apply:
 * "Suggested stop.", "Lunch stop." or "Dinner stop.", which the page does not show.
 */
export function ruleReason(
  place: ReasonPlace,
  request: Pick<TripRequest, "interests" | "mustInclude">,
  role: StopRole,
  prevPlace?: LatLng | null,
): string {
  const sentences: string[] = [];
  // Decision: "close to your previous stop" only for a meal, and only when the leg is a walk.
  // Saying it of a taxi ride would be a claim the data does not support.
  if (role !== "visit" && prevPlace && isWalk(prevPlace, place)) {
    sentences.push("Close to your previous stop.");
  }
  if (request.mustInclude.includes(place.id)) sentences.push("You asked to include this.");
  const named = matchedInterests(place, request.interests).slice(0, MAX_NAMED_INTERESTS);
  if (named.length > 0) {
    sentences.push(`Matches your interest in ${joinWords(named.map(interestWords))}.`);
  }
  const listed = listedSentence(place, named);
  if (listed) sentences.push(listed);
  const rating = ratingSentence(place);
  if (rating) sentences.push(rating);
  return fitSentences(sentences, FALLBACK[role]);
}

/**
 * The reason with "Lunch is part of this outing." (or dinner) added when the stop is an outing
 * under way through that meal's window and the day has no stop for that meal (`seated`), so the
 * traveler sees why. A bare "Suggested stop." gives way to the sentence. Unchanged when the
 * sentence does not fit REASON_MAX_CHARS.
 */
export function withMealsCovered(
  reason: string,
  place: Pick<Place, "mealCapable" | "durationMin">,
  stop: Pick<Stop, "start" | "end" | "role">,
  seated: readonly Meal[] = [],
): string {
  if (stop.role !== "visit") return reason;
  const meals = (["lunch", "dinner"] as const).filter(
    (meal) => !seated.includes(meal) && coversMeal(place, stop.start, stop.end, meal),
  );
  if (meals.length === 0) return reason;
  const verb = meals.length > 1 ? "are" : "is";
  const sentence = `${capitalize(joinWords([...meals]))} ${verb} part of this outing.`;
  const next = reason === FALLBACK.visit ? sentence : `${reason} ${sentence}`;
  return next.length <= REASON_MAX_CHARS ? next : reason;
}

/** The traveler's interests the place is tagged with, in the order asked, without repeats. */
function matchedInterests(place: ReasonPlace, interests: readonly string[]): string[] {
  return [...new Set(interests)].filter((interest) => place.tags.includes(interest));
}

/** "local-favorite" reads "local favorite". */
function interestWords(tag: string): string {
  return tag.replace(/-/g, " ");
}

/**
 * "Listed as iconic and a local favorite." for the rewarded tags the place carries, or null.
 * A tag already named as a matched interest is not said twice.
 */
function listedSentence(place: ReasonPlace, named: readonly string[]): string | null {
  const words = LISTED_TAGS.filter(
    ({ tag }) => place.tags.includes(tag) && !named.includes(tag),
  ).map((listed) => listed.words);
  return words.length === 0 ? null : `Listed as ${joinWords(words)}.`;
}

/** "Rated 4.8 out of 5." with at most one decimal, or null without a rating. */
function ratingSentence(place: ReasonPlace): string | null {
  if (place.rating === null || !Number.isFinite(place.rating)) return null;
  return `Rated ${Number(place.rating.toFixed(1))} out of 5.`;
}

function isWalk(from: LatLng, to: LatLng): boolean {
  try {
    return travelMode(from, to) === "walk";
  } catch {
    return false; // non-finite coordinates: make no closeness claim
  }
}

/** Joins sentences in order while the total fits REASON_MAX_CHARS; `fallback` when none fit. */
function fitSentences(sentences: string[], fallback: string): string {
  let text = "";
  for (const sentence of sentences) {
    // Control and format characters from the data (newlines, bidi overrides) become spaces.
    const clean = sentence.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
    const next = text === "" ? clean : `${text} ${clean}`;
    if (next.length <= REASON_MAX_CHARS) text = next;
  }
  return text === "" ? fallback : text;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
