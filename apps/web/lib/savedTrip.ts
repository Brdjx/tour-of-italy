import {
  dataVersion,
  type Itinerary,
  type PlannerContext,
  RecordIdSchema,
  type TripRequest,
} from "@italy/planner";
import { fetchTrip as defaultFetchTrip, type RequestOptions, type SaveTripBody } from "./api";
import { isApiError } from "./apiError";
import type { PlannedBy, SavedTripResponse } from "./apiSchemas";
import { rebuildShared, SHARE_VERSION } from "./shareLink";

// Saved trips, the page's side. Copy link saves the trip on the server (POST /api/trips, the body
// built here) and copies `?t=<id>`; opening such a link fetches the trip and shows it exactly as
// it was saved, or, when the place data has changed since, times it again from its ids like a
// `?p=` link. Every failure ends in a plain note over the form, never a crash.

export const TRIP_PARAM = "t";

/** A trip opened from a saved link: which one, when it was saved, and how it was planned. */
export interface SavedTrip {
  id: string;
  createdAt: string; // ISO timestamp of the save
  plannedBy: PlannedBy;
  edited: boolean; // edited before it was saved
  retimed: boolean; // timed again here, because the place data changed since it was saved
}

// Decision: no "below" or "above", as with the shared-link notes: the note sits over the form
// on phones and beside it on wide screens.
export const SAVED_NOTES = {
  notFound: "This saved trip could not be found. Plan a new trip with the form.",
  failed: "The saved trip could not be loaded. Check the connection and open the link again.",
  waiting: "The saved trip will open once the connection is back.",
  retimed:
    "Opened a saved trip. The place data has changed since it was saved, so its times were worked out again and its why lines come from the rules.",
  stale:
    "This saved trip no longer fits the current data. Its trip settings are filled in, so you can plan it again.",
  damaged: "This saved trip could not be opened. Plan a new trip with the form.",
  opened: "Opened a saved trip.",
} as const;

/** The body that saves `itinerary`: its request without notes, each day's ids, its AI source. */
export function saveTripBody(itinerary: Itinerary, savedFrom: string | null = null): SaveTripBody {
  const { notes: _notes, ...request } = itinerary.request;
  const source =
    itinerary.planId !== undefined
      ? { planId: itinerary.planId }
      : savedFrom !== null
        ? { tripId: savedFrom }
        : {};
  return {
    request,
    days: itinerary.days.map((day) => ({
      anchorId: day.anchorId,
      ids: day.stops.map((stop) => stop.placeId),
    })),
    ...source,
  };
}

/** The `?t=` value from a query string, or null. */
export function readTripParam(search: string): string | null {
  try {
    return new URLSearchParams(search).get(TRIP_PARAM);
  } catch {
    return null;
  }
}

export type LoadedTrip =
  | { kind: "found"; trip: SavedTripResponse }
  | { kind: "missing" } // no such trip, or a link id that cannot be one
  | { kind: "failed" }; // offline, a timeout, a server error, or a reply this page cannot read

export type FetchTrip = (id: string, options?: RequestOptions) => Promise<SavedTripResponse>;

/** Fetches a saved trip. Never throws. */
export async function loadSavedTrip(
  id: string,
  fetchTrip: FetchTrip = defaultFetchTrip,
): Promise<LoadedTrip> {
  if (!RecordIdSchema.safeParse(id).success) return { kind: "missing" };
  try {
    return { kind: "found", trip: await fetchTrip(id) };
  } catch (error) {
    // CloudFront turns the API's JSON 404 into the site's 404 page, so the status decides.
    if (isApiError(error) && error.kind === "http" && error.status === 404) {
      return { kind: "missing" };
    }
    return { kind: "failed" };
  }
}

export type SavedOpen =
  | { status: "plan"; itinerary: Itinerary; saved: SavedTrip; note: string | null }
  | { status: "request"; request: TripRequest; note: string }
  | { status: "invalid"; note: string; keepLink: boolean };

/**
 * What to show for a loaded trip with the places on this page. The trip as saved when this page
 * has the same place data; timed again from its ids when not; a note otherwise. Never throws.
 */
export function openSavedTrip(
  loaded: LoadedTrip,
  ctx: PlannerContext,
  generatedAt: string,
): SavedOpen {
  if (loaded.kind === "missing") {
    return { status: "invalid", note: SAVED_NOTES.notFound, keepLink: false };
  }
  // Decision: a failed load keeps ?t= in the address bar, so a reload tries again.
  if (loaded.kind === "failed")
    return { status: "invalid", note: SAVED_NOTES.failed, keepLink: true };
  const { trip } = loaded;
  const saved: SavedTrip = {
    id: trip.id,
    createdAt: trip.createdAt,
    plannedBy: trip.origin.plannedBy,
    edited: trip.origin.edited,
    retimed: false,
  };
  if (trip.dataVersion === dataVersion(ctx.places)) {
    return { status: "plan", itinerary: trip.itinerary, saved, note: null };
  }
  return retimed(trip, saved, ctx, generatedAt);
}

/** The saved trip timed again from its ids with the current places, like a ?p= link. */
function retimed(
  trip: SavedTripResponse,
  saved: SavedTrip,
  ctx: PlannerContext,
  generatedAt: string,
): SavedOpen {
  const { itinerary } = trip;
  const payload = {
    v: SHARE_VERSION,
    request: itinerary.request,
    days: itinerary.days.map((day) => ({
      anchorId: day.anchorId,
      ids: day.stops.map((stop) => stop.placeId),
    })),
  } as const;
  const notes = { opened: SAVED_NOTES.retimed, stale: SAVED_NOTES.stale };
  let result: ReturnType<typeof rebuildShared>;
  try {
    result = rebuildShared(payload, ctx, generatedAt, notes);
  } catch {
    // The planner threw on the saved ids (a bug, or data it cannot read): a note, not a crash.
    return { status: "invalid", note: SAVED_NOTES.damaged, keepLink: false };
  }
  if (result.status === "request") return result;
  const retimedTrip = { ...saved, retimed: true };
  return { status: "plan", itinerary: result.itinerary, saved: retimedTrip, note: result.note };
}
