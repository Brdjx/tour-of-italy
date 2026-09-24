import { normalizePlaces } from "./normalize/index";
import { buildDataSummary } from "./normalize/summary";
import type { DataSummary, NormalizeResult, Place } from "./types";

// The data loader. It takes the raw JSON (the API and the scripts read the file; the planner
// never does I/O) and returns everything the rest of the app needs from it.

export interface Dataset extends NormalizeResult {
  byId: ReadonlyMap<string, Place>; // schedulable places by id
  summary: DataSummary; // plain-language notes for the "About this data" panel
}

/** Normalizes raw JSON into a dataset. Pure; never throws. */
export function buildDataset(raw: unknown): Dataset {
  const result = normalizePlaces(raw);
  const byId = new Map(result.places.map((place) => [place.id, place]));
  return { ...result, byId, summary: buildDataSummary(result) };
}
