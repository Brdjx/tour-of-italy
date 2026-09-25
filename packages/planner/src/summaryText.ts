import type { PlannerContext } from "./context";
import { namesPlaceOutside } from "./placeMentions";
import type { Itinerary } from "./types";

// The AI summary for the places a trip has now. The API cleans the model's summary for the plan
// it made; after an edit, or when a trip is saved, a sentence can name a place the trip no longer
// has. The page runs this on every plan it shows, and the API runs it when it saves a trip, both
// on the summary as the AI plan came with it, so the traveler and whoever opens their saved trip
// see the same summary.

/** The summary's sentences, split after ., ! or ? and trimmed. */
export function summarySentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * The summary without the sentences that name a dataset place outside `placeIds`, or undefined
 * when there is no summary or nothing is left.
 */
export function summaryForPlaces(
  summary: string | undefined,
  placeIds: ReadonlySet<string>,
  ctx: PlannerContext,
): string | undefined {
  if (summary === undefined) return undefined;
  const kept = summarySentences(summary).filter(
    (sentence) => !namesPlaceOutside(sentence, placeIds, ctx),
  );
  return kept.length === 0 ? undefined : kept.join(" ");
}

/** Every place id on the trip's days. */
export function tripPlaceIds(itinerary: Pick<Itinerary, "days">): Set<string> {
  return new Set(itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
}

/** The itinerary's summary for the places it has now (summaryForPlaces). */
export function summaryForTrip(
  itinerary: Pick<Itinerary, "days" | "summary">,
  ctx: PlannerContext,
): string | undefined {
  return summaryForPlaces(itinerary.summary, tripPlaceIds(itinerary), ctx);
}
