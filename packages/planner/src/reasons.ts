import { REASON_MAX_CHARS } from "./config";
import { type LatLng, travelMode } from "./travel";
import type { Place, PlaceType, StopRole, TripRequest } from "./types";

// Rule-based reasons: one short sentence or two per stop, built only from the place's own data
// and the request. Used by the deterministic planner, and in place of any AI reason the API
// drops. The caller sets reasonSource: "rule".
// Decision: rule reasons never contain clock times, durations, prices, or another place's name,
// so they pass the same sanitizer as AI reasons and can never be dropped in a loop.

const TYPE_WORDS: Record<PlaceType, string> = {
  historic_site: "historic site",
  restaurant: "restaurant",
  experience: "experience",
  museum: "museum",
  viewpoint: "viewpoint",
  cafe: "cafe",
  neighborhood: "neighborhood",
  market: "market",
  park: "park",
  shop: "shop",
  other: "place",
};

const FALLBACK: Record<StopRole, string> = {
  visit: "Suggested stop.",
  lunch: "Lunch stop.",
  dinner: "Dinner stop.",
};

/** Types named in a meal reason ("Lunch at a market in Testaccio"). */
// Decision: other allowlisted meal places (a cicchetti crawl is an "experience") read as "Dinner
// in Cannaregio", because "Dinner at an experience" is not plain English. Every venue word here
// starts with a consonant, so the article is always "a".
const MEAL_VENUE_TYPES: readonly PlaceType[] = ["restaurant", "cafe", "market", "shop"];

/** Most matched interests named in one reason, so the sentence stays short. */
const MAX_NAMED_INTERESTS = 3;

/** The place fields a reason reads. */
export type ReasonPlace = Pick<
  Place,
  "id" | "type" | "city" | "neighborhood" | "rating" | "tags" | "lat" | "lng"
>;

/**
 * A reason built only from data, at most REASON_MAX_CHARS long and never empty. Sentences are
 * added in priority order while they fit; a sentence too long for the limit (a very long
 * neighborhood name, say) is skipped rather than cut mid-word.
 *
 * - Visit: "You asked to include this." when must-include; "Matches your interest in food and
 *   wine." or "Museum in Florence."; "Rated 4.8 out of 5."; "A local favorite."
 * - Lunch or dinner: "Dinner at a restaurant in Trastevere, close to your previous stop." (the
 *   closeness clause only when the previous stop is within walking distance), then
 *   "You asked to include this.", the interest match, and the rating.
 */
export function ruleReason(
  place: ReasonPlace,
  request: Pick<TripRequest, "interests" | "mustInclude">,
  role: StopRole,
  prevPlace?: LatLng | null,
): string {
  const sentences =
    role === "visit"
      ? visitSentences(place, request)
      : mealSentences(place, request, role, prevPlace ?? null);
  return fitSentences(sentences, FALLBACK[role]);
}

function visitSentences(
  place: ReasonPlace,
  request: Pick<TripRequest, "interests" | "mustInclude">,
): string[] {
  const sentences: string[] = [];
  if (request.mustInclude.includes(place.id)) sentences.push("You asked to include this.");
  const interests = interestSentence(place, request.interests);
  sentences.push(interests ?? `${capitalize(TYPE_WORDS[place.type])} in ${areaOf(place)}.`);
  const rating = ratingSentence(place);
  if (rating) sentences.push(rating);
  if (place.tags.includes("local-favorite")) sentences.push("A local favorite.");
  return sentences;
}

function mealSentences(
  place: ReasonPlace,
  request: Pick<TripRequest, "interests" | "mustInclude">,
  role: "lunch" | "dinner",
  prevPlace: LatLng | null,
): string[] {
  const venue = MEAL_VENUE_TYPES.includes(place.type) ? ` at a ${TYPE_WORDS[place.type]}` : "";
  const where = `${capitalize(role)}${venue} in ${areaOf(place)}`;
  // Decision: "close to your previous stop" only when the leg is a walk. Saying it of a taxi ride
  // would be a claim the data does not support.
  const close = prevPlace !== null && isWalk(prevPlace, place);
  const sentences = [close ? `${where}, close to your previous stop.` : `${where}.`];
  if (request.mustInclude.includes(place.id)) sentences.push("You asked to include this.");
  const interests = interestSentence(place, request.interests);
  if (interests) sentences.push(interests);
  const rating = ratingSentence(place);
  if (rating) sentences.push(rating);
  return sentences;
}

/** "Matches your interest in food, wine and art." or null when nothing matches. */
function interestSentence(place: ReasonPlace, interests: readonly string[]): string | null {
  const matched: string[] = [];
  for (const interest of new Set(interests)) {
    if (place.tags.includes(interest)) matched.push(interest.replace(/-/g, " "));
  }
  if (matched.length === 0) return null;
  return `Matches your interest in ${joinWords(matched.slice(0, MAX_NAMED_INTERESTS))}.`;
}

/** "Rated 4.8 out of 5." with at most one decimal, or null without a rating. */
function ratingSentence(place: ReasonPlace): string | null {
  if (place.rating === null || !Number.isFinite(place.rating)) return null;
  return `Rated ${Number(place.rating.toFixed(1))} out of 5.`;
}

/** Neighborhood when known, else the city. A neighborhood-type place uses its city. */
function areaOf(place: ReasonPlace): string {
  if (place.type === "neighborhood" || place.neighborhood === null) return place.city;
  return place.neighborhood;
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
