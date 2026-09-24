import {
  buildDataSummary,
  buildPlannerContext,
  type DataSummary,
  type Place,
  type PlannerContext,
} from "@italy/planner";
import { fetchDataIssues, fetchMeta, fetchPlaces, type RequestOptions } from "./api";
import { ApiError, isApiError } from "./apiError";
import type { DataIssuesResponse, Meta } from "./apiSchemas";
import { forgetCachedApi } from "./sw/apiCache";
import { buildTripOptions, type TripOptions } from "./tripOptions";

// Loads what the page needs before the traveler can plan: the places (required: the form's
// pickers, edits, share links and the offline fallback all run the planner on them), plus the
// form metadata and the data notes (optional: both can be rebuilt from the places).

export interface TripData {
  places: Place[];
  ctx: PlannerContext;
  options: TripOptions;
  summary: DataSummary;
}

export interface TripDataClient {
  fetchMeta: (options?: RequestOptions) => Promise<Meta>;
  fetchPlaces: (options?: RequestOptions) => Promise<Place[]>;
  fetchDataIssues: (options?: RequestOptions) => Promise<DataIssuesResponse>;
  forgetCached?: (paths: readonly string[]) => Promise<void>; // the worker's saved copies
}

export const defaultClient: TripDataClient = {
  fetchMeta,
  fetchPlaces,
  fetchDataIssues,
  forgetCached: (paths) => forgetCachedApi(paths),
};

/** A reply that arrived but could not be read: possibly a stale copy the worker kept. */
function unreadable(error: unknown): boolean {
  return isApiError(error) && (error.kind === "parse" || error.kind === "schema");
}

/**
 * The places. An unreadable reply is removed from the worker's cache and asked for once more,
 * so a bad copy kept while the API was broken cannot outlive the fix.
 */
async function loadPlaces(client: TripDataClient, options: RequestOptions): Promise<Place[]> {
  try {
    return await client.fetchPlaces(options);
  } catch (error) {
    if (!unreadable(error) || !client.forgetCached) throw error;
    await client.forgetCached(["/api/places"]);
    return client.fetchPlaces(options);
  }
}

/** Loads all three in parallel. Throws the places error when the places cannot be loaded. */
export async function loadTripData(
  signal?: AbortSignal,
  client: TripDataClient = defaultClient,
): Promise<TripData> {
  const options = signal ? { signal } : {};
  const [meta, places, issues] = await Promise.allSettled([
    client.fetchMeta(options),
    loadPlaces(client, options),
    client.fetchDataIssues(options),
  ]);
  // Meta is optional (the form rebuilds it from the places), but a copy the page cannot read
  // is still removed so it is not served again.
  if (meta.status === "rejected" && unreadable(meta.reason)) {
    await client.forgetCached?.(["/api/meta"]);
  }
  if (places.status === "rejected") throw places.reason;
  let ctx: PlannerContext;
  try {
    ctx = contextFor(places.value);
  } catch (error) {
    await client.forgetCached?.(["/api/places"]);
    throw error;
  }
  return {
    places: places.value,
    ctx,
    options: buildTripOptions(ctx, meta.status === "fulfilled" ? meta.value : null),
    summary: summaryFor(issues.status === "fulfilled" ? issues.value : null, places.value),
  };
}

function contextFor(places: Place[]): PlannerContext {
  if (places.length === 0) {
    throw new ApiError({ kind: "schema", message: "The place list was empty" });
  }
  try {
    return buildPlannerContext(places);
  } catch {
    // Two places with one id: every lookup would pick one at random, so refuse the list.
    throw new ApiError({ kind: "schema", message: "The place list had repeated ids" });
  }
}

/** The data notes: the API's summary when sent, otherwise rebuilt from what did arrive. */
export function summaryFor(response: DataIssuesResponse | null, places: Place[]): DataSummary {
  if (response?.summary) return response.summary;
  return buildDataSummary({
    places,
    excluded: response?.excluded ?? [],
    issues: response?.issues ?? places.flatMap((place) => place.issues),
  });
}
