import type { Itinerary, TripRequest } from "./types";

// The traveler's notes ("Anything else?") are private: they go to the AI and never into a saved
// trip. The AI can still echo them, in its summary ("Since you mentioned your knee...") or in a
// why line ("A calm stop that suits your recent surgery"). So when a plan was made with notes, a
// saved trip carries none of the AI's text: no summary, and the rule's why line on every stop.
// The API applies this when it keeps a plan's AI content (services/api/src/trips/records.ts),
// and the page uses the same rule to tell the traveler, when they copy the link, what the shared
// trip leaves out.

// Decision: no AI text at all for a plan with notes, not only the lines that look like an echo.
// An earlier rule kept why lines that did not speak to the traveler ("you", "your"), but an echo
// need not address anyone ("A calm stop after knee surgery"), and no test on the words can tell
// a paraphrase of the notes from a line about the place. Leaving all of it out is the one rule
// that holds whatever the model writes.

/** True when the request carries notes for the AI. */
export function hasNotes(request: Pick<TripRequest, "notes">): boolean {
  return request.notes !== undefined && request.notes.trim() !== "";
}

/** What a saved trip of this plan leaves out of the AI's text, to keep the notes private. */
export interface PrivateAiText {
  summary: boolean; // the plan has an AI summary, and it is left out
  reasons: number; // AI why lines left out; those stops get the rule's why line
}

/**
 * What a saved trip of `itinerary` leaves out: nothing when its request has no notes, otherwise
 * its summary and every AI why line. Pass the summary as it is shown (summaryForTrip), so a
 * summary the trip's places already removed is not counted.
 */
export function privateAiText(
  itinerary: Pick<Itinerary, "request" | "days" | "summary">,
): PrivateAiText {
  if (!hasNotes(itinerary.request)) return { summary: false, reasons: 0 };
  let reasons = 0;
  for (const day of itinerary.days) {
    for (const stop of day.stops) {
      if (stop.reasonSource === "ai" && stop.reason) reasons++;
    }
  }
  return { summary: itinerary.summary !== undefined, reasons };
}
