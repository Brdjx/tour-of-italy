import { FAR_FROM_CITY_KM } from "../config";
import type { DataIssue, ExcludedRecord } from "../types";
import { haversineKm, type LatLng, medianCentroid } from "./geo";
import { foldText, makeIssue } from "./issue";
import { groupBy, UNKNOWN_CITY } from "./locations";
import type { PlaceDraft } from "./record";

// Cross-record steps that are not about coordinates: filling a missing city or region from
// other records, and merging duplicate places. Drafts are updated in place; they are private to
// normalizePlaces.

export const UNKNOWN_REGION = "Unknown region";

/** Sets a missing city to the nearest city center (median of its places) within FAR_FROM_CITY_KM. */
// Decision: compare with city centers, not every place, so the cost grows with the number of
// cities rather than the number of records (10,000 records without a city stay fast).
export function inferMissingCities(drafts: PlaceDraft[]): void {
  const centers: { city: string; center: LatLng }[] = [];
  const located = drafts.filter((d) => d.city !== null && d.location !== null);
  for (const [city, members] of groupBy(located, (d) => d.city ?? "")) {
    const center = medianCentroid(members.flatMap((d) => (d.location ? [d.location] : [])));
    if (center) centers.push({ city, center });
  }
  for (const draft of drafts) {
    if (draft.city !== null) continue;
    const nearest = draft.location ? nearestCenter(draft.location, centers) : null;
    draft.city = nearest?.city ?? UNKNOWN_CITY;
    const action = nearest
      ? `Used ${nearest.city}, the nearest city with listed places (${nearest.km.toFixed(1)} km from its center)`
      : `Shown as "${UNKNOWN_CITY}"; the place joins the nearest base by distance`;
    setAction(draft.issues, "city_missing", action);
  }
}

function nearestCenter(
  point: LatLng,
  centers: { city: string; center: LatLng }[],
): { city: string; km: number } | null {
  let best: { city: string; km: number } | null = null;
  for (const { city, center } of centers) {
    const km = haversineKm(point, center);
    if (km <= FAR_FROM_CITY_KM && (best === null || km < best.km)) best = { city, km };
  }
  return best;
}

/** Sets a missing region to the most common region among the same city's places. */
export function fillMissingRegions(drafts: PlaceDraft[]): void {
  const byCity = groupBy(
    drafts.filter((d) => d.region !== null && d.city !== null),
    (d) => d.city ?? "",
  );
  for (const draft of drafts) {
    if (draft.region !== null) continue;
    const counts = new Map<string, number>();
    for (const other of byCity.get(draft.city ?? "") ?? []) {
      const region = other.region ?? UNKNOWN_REGION;
      counts.set(region, (counts.get(region) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    draft.region = best?.[0] ?? UNKNOWN_REGION;
    const action = best
      ? `Used ${draft.region}, the region of other places in ${draft.city}`
      : `Shown as "${UNKNOWN_REGION}"`;
    setAction(draft.issues, "region_missing", action);
  }
}

function setAction(issues: DataIssue[], kind: DataIssue["kind"], action: string): void {
  for (const issue of issues) if (issue.kind === kind) issue.action = action;
}

/**
 * Merges records with the same name in the same city. The most complete record is kept (ties go
 * to the earlier one), it gains the others' tags, and each dropped record is logged.
 */
export function mergeDuplicates(drafts: PlaceDraft[]): {
  kept: PlaceDraft[];
  dropped: ExcludedRecord[];
} {
  const groups = groupBy(drafts, (d) => `${foldText(d.name ?? "")}|${foldText(d.city ?? "")}`);
  const droppedIds = new Set<string>();
  const dropped: ExcludedRecord[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = [...group].sort(
      (a, b) => completeness(b) - completeness(a) || a.sourceIndex - b.sourceIndex,
    )[0];
    if (!keeper) continue;
    for (const other of group) {
      if (other === keeper) continue;
      for (const tag of other.tags) if (!keeper.tags.includes(tag)) keeper.tags.push(tag);
      droppedIds.add(other.id);
      const detail = `Same name and city as ${keeper.id} (${keeper.name})`;
      const action = `Merged into ${keeper.id}, which has more complete data; tags combined`;
      other.issues.push(
        makeIssue(
          { placeId: other.id, field: "name" },
          "duplicate_place",
          other.name,
          detail,
          action,
        ),
      );
      dropped.push({ id: other.id, name: other.name, reason: "duplicate", detail });
    }
  }
  return { kept: drafts.filter((d) => !droppedIds.has(d.id)), dropped };
}

/** How much usable data a record has, for choosing which duplicate to keep. */
function completeness(draft: PlaceDraft): number {
  let score = 0;
  if (draft.hoursConfidence === "listed") score += 2;
  if (draft.durationSource === "listed") score += 1;
  if (draft.priceLevel !== null) score += 1;
  if (draft.rating !== null) score += 1;
  if (draft.location?.source === "listed") score += 1;
  if (draft.neighborhood !== null) score += 1;
  if (draft.description !== "") score += 1;
  if (draft.tags.length > 0) score += 1;
  if (draft.bookingRequired !== null) score += 1;
  return score;
}
