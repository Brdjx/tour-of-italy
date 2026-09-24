import { FAR_FROM_CITY_KM, MIN_SIBLINGS_FOR_FAR_CHECK } from "../config";
import { haversineKm, type LatLng, medianCentroid } from "./geo";
import { makeIssue } from "./issue";
import type { DraftLocation, PlaceDraft } from "./record";

// Cross-record location steps, run on all drafts together:
//   1. far check: a point more than FAR_FROM_CITY_KM from the median of its city's other places
//   2. repair: far or missing points move to the median of trusted places in the same city and
//      neighborhood, else the same city; with nothing to repair from, a missing point excludes
//      the record and a far point is kept
// Shared locations (step 3) are in sharedLocations.ts.
// Drafts are updated in place; they are private to normalizePlaces.

export const UNKNOWN_CITY = "Unknown city";

/** Median of the city's other places, for each draft that has a point. */
function othersCentroids(
  drafts: PlaceDraft[],
): Map<PlaceDraft, { centroid: LatLng; count: number }> {
  const byCity = groupBy(
    drafts.filter((d) => d.location !== null && d.city !== null),
    (d) => d.city ?? "",
  );
  const result = new Map<PlaceDraft, { centroid: LatLng; count: number }>();
  for (const members of byCity.values()) {
    const lats = members.map((d) => d.location?.lat ?? 0).sort((a, b) => a - b);
    const lngs = members.map((d) => d.location?.lng ?? 0).sort((a, b) => a - b);
    for (const draft of members) {
      if (members.length < 2 || !draft.location) continue;
      const centroid = {
        lat: medianWithout(lats, draft.location.lat),
        lng: medianWithout(lngs, draft.location.lng),
      };
      result.set(draft, { centroid, count: members.length - 1 });
    }
  }
  return result;
}

/** Median of a sorted list with one occurrence of `value` removed. */
function medianWithout(sorted: number[], value: number): number {
  const removed = sorted.indexOf(value);
  const at = (k: number) => sorted[k < removed ? k : k + 1] ?? Number.NaN;
  const size = sorted.length - 1;
  const middle = Math.floor(size / 2);
  return size % 2 === 1 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
}

/** Flags far points, then repairs far and missing points. Returns the ids that cannot be placed. */
export function repairLocations(drafts: PlaceDraft[]): Set<string> {
  const far = new Set<PlaceDraft>();
  for (const [draft, { centroid, count }] of othersCentroids(drafts)) {
    if (count < MIN_SIBLINGS_FOR_FAR_CHECK || !draft.location) continue;
    if (haversineKm(draft.location, centroid) > FAR_FROM_CITY_KM) far.add(draft);
  }
  const trusted = drafts.filter((d) => d.location !== null && !far.has(d) && d.city !== null);
  const byCity = groupBy(trusted, (d) => d.city ?? "");
  const byNeighborhood = groupBy(
    trusted.filter((d) => d.neighborhood !== null),
    (d) => `${d.city}|${d.neighborhood?.toLowerCase()}`,
  );
  const unplaceable = new Set<string>();
  for (const draft of drafts) {
    if (draft.location !== null && !far.has(draft)) continue;
    const repaired = repairPoint(draft, byCity, byNeighborhood);
    if (far.has(draft)) logFar(draft, repaired);
    else if (repaired) applyRepair(draft, repaired);
    else logUnrepairable(draft, unplaceable);
  }
  return unplaceable;
}

function repairPoint(
  draft: PlaceDraft,
  byCity: Map<string, PlaceDraft[]>,
  byNeighborhood: Map<string, PlaceDraft[]>,
): DraftLocation | null {
  if (draft.city === null || draft.city === UNKNOWN_CITY) return null;
  const siblings = draft.neighborhood
    ? byNeighborhood.get(`${draft.city}|${draft.neighborhood.toLowerCase()}`)
    : undefined;
  const pointsOf = (list: PlaceDraft[]) => list.flatMap((d) => (d.location ? [d.location] : []));
  const neighborhoodCentroid = siblings ? medianCentroid(pointsOf(siblings)) : null;
  if (neighborhoodCentroid) return { ...neighborhoodCentroid, source: "neighborhood_centroid" };
  const cityCentroid = medianCentroid(pointsOf(byCity.get(draft.city) ?? []));
  return cityCentroid ? { ...cityCentroid, source: "city_centroid" } : null;
}

function logFar(draft: PlaceDraft, repaired: DraftLocation | null): void {
  const listed = draft.location;
  if (!listed) return;
  const target = { placeId: draft.id, field: "latitude,longitude" };
  const detail = `(${listed.lat}, ${listed.lng}) is more than ${FAR_FROM_CITY_KM} km from the other places in ${draft.city}`;
  if (!repaired) {
    draft.issues.push(
      makeIssue(
        target,
        "coords_far_from_city",
        [listed.lat, listed.lng],
        detail,
        "Kept: nothing reliable to repair from",
      ),
    );
    return;
  }
  const action = `Moved to the middle of ${placeLabel(draft, repaired)} (${round(repaired.lat)}, ${round(repaired.lng)}); marked approximate`;
  draft.issues.push(
    makeIssue(target, "coords_far_from_city", [listed.lat, listed.lng], detail, action),
  );
  draft.location = repaired;
}

/** Uses the estimate for a missing point and says so on the issue that reported it. */
function applyRepair(draft: PlaceDraft, repaired: DraftLocation): void {
  draft.location = repaired;
  const action = `Estimated as the middle of ${placeLabel(draft, repaired)} (${round(repaired.lat)}, ${round(repaired.lng)}); marked approximate`;
  for (const issue of draft.issues) {
    if (issue.kind === "coords_missing" || issue.kind === "coords_out_of_bounds")
      issue.action = action;
  }
}

function placeLabel(draft: PlaceDraft, repaired: DraftLocation): string {
  return repaired.source === "neighborhood_centroid"
    ? `the ${draft.neighborhood} neighborhood`
    : `${draft.city}`;
}

function logUnrepairable(draft: PlaceDraft, unplaceable: Set<string>): void {
  const target = { placeId: draft.id, field: "latitude,longitude" };
  const detail = `No usable coordinates and no other places in ${draft.city ?? "an unknown city"} to estimate from`;
  draft.issues.push(
    makeIssue(target, "coords_unrepairable", null, detail, "Excluded from planning"),
  );
  unplaceable.add(draft.id);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
