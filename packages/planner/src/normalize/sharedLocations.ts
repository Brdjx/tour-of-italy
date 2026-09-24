import {
  ITALY_BBOX,
  MAX_SHARED_LINKS,
  SAME_EXPERIENCE_GROUPS,
  SAME_LOCATION_MAX_M,
} from "../config";
import { haversineKm, type LatLng } from "./geo";
import { makeIssue } from "./issue";
import { groupBy } from "./locations";
import type { PlaceDraft } from "./record";

// Links places the planner must never put in the same trip: two listed points within
// SAME_LOCATION_MAX_M of each other (the same fountain by day and by night), and the reviewed
// same-experience groups in config. Links always go both ways. Drafts are updated in place.

/** Links places whose listed points are within SAME_LOCATION_MAX_M of each other. */
export function markSharedLocations(drafts: PlaceDraft[]): void {
  const listed = drafts.filter(
    (d) => d.location?.source === "listed" || d.location?.source === "swapped",
  );
  // Decision: a grid whose cells are at least SAME_LOCATION_MAX_M wide keeps this linear, so a
  // 10,000-record file stays fast, and checking the 8 neighboring cells never misses a pair.
  const grid = groupBy(listed, (d) => cellKey(d.location as LatLng, 0, 0));
  const position = new Map(listed.map((draft, index) => [draft, index]));
  for (const draft of listed) linkNeighbors(draft, grid, position);
}

/** Links one place to later places in its own and the 8 neighboring cells, up to the cap. */
function linkNeighbors(
  draft: PlaceDraft,
  grid: Map<string, PlaceDraft[]>,
  position: Map<PlaceDraft, number>,
): void {
  const point = draft.location as LatLng;
  const own = position.get(draft) ?? -1;
  for (const [dLat, dLng] of NEIGHBOR_CELLS) {
    const cell = grid.get(cellKey(point, dLat, dLng)) ?? [];
    // Each pair is checked once, from its earlier member: skip straight to later places.
    for (let index = firstAfter(cell, own, position); index < cell.length; index++) {
      const other = cell[index] as PlaceDraft;
      if (draft.sharedLocationWith.length >= MAX_SHARED_LINKS) return;
      if (other.sharedLocationWith.length >= MAX_SHARED_LINKS) continue;
      const meters = haversineKm(point, other.location as LatLng) * 1000;
      if (meters <= SAME_LOCATION_MAX_M) linkPair(draft, other);
    }
  }
}

/** Index of the first cell member after `own` (cells keep source order, so binary search). */
function firstAfter(cell: PlaceDraft[], own: number, position: Map<PlaceDraft, number>): number {
  let low = 0;
  let high = cell.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((position.get(cell[middle] as PlaceDraft) ?? -1) <= own) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Links two places both ways and logs the link on each. */
function linkPair(a: PlaceDraft, b: PlaceDraft): void {
  for (const [draft, other] of [
    [a, b],
    [b, a],
  ] as const) {
    draft.sharedLocationWith.push(other.id);
    const point = draft.location as LatLng;
    const detail = `Same coordinates as ${other.id} (${other.name ?? "unnamed"})`;
    const action = "Both kept as separate experiences; the planner never puts both in one trip";
    const target = { placeId: draft.id, field: "latitude,longitude" };
    draft.issues.push(makeIssue(target, "shared_location", [point.lat, point.lng], detail, action));
  }
}

/** Links the reviewed same-experience groups in config, both ways. */
export function linkSameExperiences(drafts: PlaceDraft[]): void {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  for (const group of SAME_EXPERIENCE_GROUPS) {
    const members = group.ids.flatMap((id) => byId.get(id) ?? []);
    for (const draft of members) {
      for (const other of members) {
        if (other === draft || draft.sharedLocationWith.includes(other.id)) continue;
        draft.sharedLocationWith.push(other.id);
        const detail = `Same experience as ${other.id} (${other.name ?? "unnamed"}): ${group.reason}`;
        const action = "Both kept; the planner never puts both in one trip";
        const target = { placeId: draft.id, field: "name" };
        draft.issues.push(makeIssue(target, "same_experience", other.id, detail, action));
      }
    }
  }
}

const NEIGHBOR_CELLS = [-1, 0, 1].flatMap((dLat) =>
  [-1, 0, 1].map((dLng) => [dLat, dLng] as const),
);

/**
 * Cell size in degrees: SAME_LOCATION_MAX_M of longitude at Italy's northern edge, where a degree
 * of longitude is shortest, measured with the same haversine the link check uses.
 */
const METERS_PER_DEGREE_AT_NORTH_EDGE =
  haversineKm({ lat: ITALY_BBOX.maxLat, lng: 0 }, { lat: ITALY_BBOX.maxLat, lng: 1 }) * 1000;
export const CELL_DEGREES = Math.max(SAME_LOCATION_MAX_M, 1) / METERS_PER_DEGREE_AT_NORTH_EDGE;

function cellKey(point: LatLng, dLat: number, dLng: number): string {
  const row = Math.floor(point.lat / CELL_DEGREES) + dLat;
  const column = Math.floor(point.lng / CELL_DEGREES) + dLng;
  return `${row}:${column}`;
}
