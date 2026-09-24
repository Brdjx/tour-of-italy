import type { DataIssue, DataSummary, ExcludedRecord, NormalizeResult, Place } from "../types";
import { fillMissingRegions, inferMissingCities, mergeDuplicates } from "./crossRecord";
import { normalizeId, resolveIdCollisions } from "./ids";
import { makeIssue } from "./issue";
import { repairLocations } from "./locations";
import { readRecord, readTopLevel, typeName } from "./raw";
import { normalizeRecord, type PlaceDraft } from "./record";
import { linkSameExperiences, markSharedLocations } from "./sharedLocations";
import { buildDataSummary } from "./summary";

// normalizePlaces: raw JSON in, schedulable places plus a full issue log out.
//   1. read the top level (a list, or one list under a key)
//   2. choose ids and make them unique, before anything else, so every issue has its final id
//   3. normalize each record field by field (record.ts)
//   4. cross-record: exclude nameless and closed records, infer missing cities and regions,
//      merge duplicates, repair locations, link shared locations and same experiences
// Never throws, never drops a record silently: every record ends up in `places` or `excluded`,
// and `places.length + excluded.length` equals the number of records read.

/** Everything the app needs from the raw JSON (the API and the scripts read the file). */
export interface Dataset extends NormalizeResult {
  byId: ReadonlyMap<string, Place>; // schedulable places by id
  summary: DataSummary; // plain-language notes for the "About this data" panel
}

/** Normalizes raw JSON into a dataset. Pure; never throws. The planner never does I/O. */
export function buildDataset(raw: unknown): Dataset {
  const result = normalizePlaces(raw);
  const byId = new Map(result.places.map((place) => [place.id, place]));
  return { ...result, byId, summary: buildDataSummary(result) };
}

/** Normalizes the raw dataset. Pure; never throws. */
export function normalizePlaces(raw: unknown): NormalizeResult {
  const { records, issues: datasetIssues } = readTopLevel(raw);
  const excluded: ExcludedRecord[] = [];
  const issuesByIndex = new Map<number, DataIssue[]>();

  const objects: { raw: Record<string, unknown>; index: number }[] = [];
  records.forEach((record, index) => {
    const parsed = readRecord(record);
    if (parsed) {
      objects.push({ raw: parsed, index });
      return;
    }
    const id = `record_${index + 1}`;
    const detail = `Record ${index + 1} is ${typeName(record)}, not an object`;
    const issue = makeIssue(
      { placeId: id, field: "(record)" },
      "record_invalid",
      record,
      detail,
      "Excluded",
    );
    issuesByIndex.set(index, [issue]);
    excluded.push({ id, name: null, reason: "invalid_record", detail });
  });

  const drafts = draftRecords(objects);
  for (const draft of drafts) issuesByIndex.set(draft.sourceIndex, draft.issues);

  const named = drafts.filter((draft) => {
    if (draft.name !== null) return true;
    excluded.push({ id: draft.id, name: null, reason: "missing_name", detail: "No usable name" });
    return false;
  });
  const open = named.filter((draft) => {
    if (!draft.closed) return true;
    const issue = draft.issues.find((candidate) => candidate.kind === "place_closed");
    const detail = issue?.detail ?? "The source says the place is closed";
    excluded.push({ id: draft.id, name: draft.name, reason: "closed", detail });
    return false;
  });
  inferMissingCities(open);
  fillMissingRegions(open);
  const { kept, dropped } = mergeDuplicates(open);
  excluded.push(...dropped);
  const unplaceable = repairLocations(kept);
  const placeable = kept.filter((draft) => {
    if (!unplaceable.has(draft.id)) return true;
    excluded.push({
      id: draft.id,
      name: draft.name,
      reason: "no_location",
      detail: "No usable coordinates",
    });
    return false;
  });
  markSharedLocations(placeable);
  linkSameExperiences(placeable);

  const sortedIndexes = [...issuesByIndex.keys()].sort((a, b) => a - b);
  const issues = [
    ...datasetIssues,
    ...sortedIndexes.flatMap((index) => issuesByIndex.get(index) ?? []),
  ];
  return { places: placeable.map(toPlace), excluded, issues };
}

/** Ids first (so collisions are resolved before any issue is logged), then each record. */
function draftRecords(objects: { raw: Record<string, unknown>; index: number }[]): PlaceDraft[] {
  const candidates = objects.map((object) =>
    normalizeId(object.raw.id, {
      index: object.index,
      name: object.raw.name,
      city: object.raw.city,
    }),
  );
  const resolved = resolveIdCollisions(candidates.map((candidate) => candidate.value));
  const collisionIssues = new Map(resolved.issues.map((issue) => [issue.placeId, issue]));
  return objects.map((object, position) => {
    const id = resolved.ids[position] ?? `record_${object.index + 1}`;
    const draft = normalizeRecord(object.raw, id, object.index);
    const idIssues = (candidates[position]?.issues ?? []).map((issue) => ({
      ...issue,
      placeId: id,
    }));
    const collision = collisionIssues.get(id);
    draft.issues.unshift(...idIssues, ...(collision ? [collision] : []));
    return draft;
  });
}

/** A finished draft as a Place, with every field in a fixed order. */
function toPlace(draft: PlaceDraft): Place {
  const location = draft.location ?? {
    lat: Number.NaN,
    lng: Number.NaN,
    source: "listed" as const,
  };
  return {
    id: draft.id,
    name: draft.name ?? "",
    type: draft.type,
    city: draft.city ?? "",
    region: draft.region ?? "",
    neighborhood: draft.neighborhood,
    description: draft.description,
    lat: location.lat,
    lng: location.lng,
    locationSource: location.source,
    hours: draft.hours,
    hoursConfidence: draft.hoursConfidence,
    hoursRaw: draft.hoursRaw,
    hoursDerivation: draft.hoursDerivation,
    dateRules: draft.dateRules,
    seasonalNote: draft.seasonalNote,
    durationMin: draft.durationMin,
    durationSource: draft.durationSource,
    priceLevel: draft.priceLevel,
    rating: draft.rating,
    tags: draft.tags,
    bookingRequired: draft.bookingRequired,
    bookAhead: draft.bookAhead,
    mealCapable: draft.mealCapable,
    meals: draft.meals,
    sharedLocationWith: draft.sharedLocationWith,
    issues: draft.issues,
  };
}

// The normalizer helpers the API, the web app, and the data scripts use by name.
export { haversineKm, insideItaly, median } from "./geo";
export { CITY_ALIASES, REGION_ALIASES } from "./names";
export { TYPE_ALIASES } from "./placeType";
export { RawPlaceSchema } from "./raw";
export { tagLabel } from "./tags";
