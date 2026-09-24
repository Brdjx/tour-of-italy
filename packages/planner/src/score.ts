import { compareText } from "./anchors";
import { SCORE_WEIGHTS } from "./config";
import { haversineKm, type LatLng } from "./normalize/geo";
import { hoursOn } from "./time";
import type { Place, PlaceType, TripRequest } from "./types";

// How much a traveler would want a place next. Higher is better. The score only ranks places
// that already pass the hard rules in constraints.ts; it never makes an invalid stop valid.
//
//   score = interestMatch * (interests the place matches / max(1, interests))
//         + rating * ((rating ?? 3.5) / 5)
//         + localFavorite                  if tagged local-favorite
//         - hoursUnknownPenalty            if hours are unknown on that date
//         - distancePenaltyPerKm * km      from where the traveler is
//         - repeatTypePenalty              if the same type as the previous stop
//         + mustInclude                    if the traveler asked for it

/** Where and when the place would be visited. Every field is optional. */
export interface ScoreSituation {
  date?: string; // trip date; without it, "hours unknown" means no hours at all
  from?: LatLng | null; // the previous stop, or the base centroid for the first stop
  previousType?: PlaceType | null; // type of the previous stop
}

/** The request fields scoring reads. */
export type ScoreRequest = Pick<TripRequest, "interests" | "mustInclude">;

/** Each term of the score, for tests and debugging. `total` is what ranking uses. */
export interface ScoreParts {
  interest: number;
  rating: number;
  localFavorite: number;
  hoursUnknown: number; // zero or negative
  distance: number; // zero or negative
  repeatType: number; // zero or negative
  mustInclude: number;
  total: number; // sum of the terms, rounded to 6 decimals
}

/** Rating assumed when a place has none: the suggestion threshold, neither rewarded nor hidden. */
export const DEFAULT_RATING = 3.5;

const LOCAL_FAVORITE_TAG = "local-favorite";

/** The share of the traveler's distinct interests that the place is tagged with, 0..1. */
export function interestShare(place: Pick<Place, "tags">, interests: readonly string[]): number {
  const wanted = new Set(interests);
  if (wanted.size === 0) return 0;
  let matched = 0;
  for (const interest of wanted) if (place.tags.includes(interest)) matched++;
  return matched / wanted.size;
}

/** Each weighted term of the score. Pure. Throws RangeError on a bad date. */
export function scoreParts(
  place: Place,
  request: ScoreRequest,
  situation: ScoreSituation = {},
): ScoreParts {
  const w = SCORE_WEIGHTS;
  const interest = w.interestMatch * interestShare(place, request.interests);
  const rating = w.rating * ((place.rating ?? DEFAULT_RATING) / 5);
  const localFavorite = place.tags.includes(LOCAL_FAVORITE_TAG) ? w.localFavorite : 0;
  const hoursUnknown = hoursUnknownOn(place, situation.date) ? -w.hoursUnknownPenalty : 0;
  const km = situation.from ? haversineKm(situation.from, place) : 0;
  const distance = km === 0 ? 0 : -w.distancePenaltyPerKm * km; // never -0
  const repeatType = situation.previousType === place.type ? -w.repeatTypePenalty : 0;
  const mustInclude = request.mustInclude.includes(place.id) ? w.mustInclude : 0;
  const sum =
    interest + rating + localFavorite + hoursUnknown + distance + repeatType + mustInclude;
  // Decision: round to 6 decimals so two places that tie on paper also tie in floating point and
  // fall back to id order, whatever order the terms were added in.
  const total = Math.round(sum * 1e6) / 1e6;
  return {
    interest,
    rating,
    localFavorite,
    hoursUnknown,
    distance,
    repeatType,
    mustInclude,
    total,
  };
}

/** The score used for ranking. Pure and deterministic. Throws RangeError on a bad date. */
export function scorePlace(
  place: Place,
  request: ScoreRequest,
  situation: ScoreSituation = {},
): number {
  return scoreParts(place, request, situation).total;
}

/** A place with its score. */
export interface ScoredPlace {
  place: Place;
  score: number;
}

/** Higher score first; equal scores in id order, so results never depend on input order. */
export function compareScored(a: ScoredPlace, b: ScoredPlace): number {
  return b.score - a.score || compareText(a.place.id, b.place.id);
}

/** Scores and sorts places, best first, ties by id. Does not filter; filter first. */
export function rankPlaces(
  places: readonly Place[],
  request: ScoreRequest,
  situation: ScoreSituation = {},
): ScoredPlace[] {
  const scored = places.map((place) => ({ place, score: scorePlace(place, request, situation) }));
  return scored.sort(compareScored);
}

/** True when the place has no usable hours: on the date when given, else at all. */
function hoursUnknownOn(place: Place, date: string | undefined): boolean {
  if (date === undefined) return place.hours === null;
  return hoursOn(place, date) === "unknown";
}
