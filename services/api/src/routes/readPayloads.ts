import {
  addDays,
  dataVersion,
  formatClock,
  type IssueKind,
  MAX_ANCHORS_PER_TRIP,
  MEALS,
  PACE,
  PACES,
  PLACE_TYPES,
  PlaceSchema,
  type PlaceType,
  placeNotes,
  REQUEST_LIMITS,
  TRIP_DAYS,
  tagLabel,
} from "@italy/planner";
import { z } from "zod";
import type { DataIssuesResponse, MetaResponse, PlacesResponse } from "../contract";
import { type AppData, interestCounts } from "../data";

// Bodies for the read-only routes. Built from the normalized data once per process, so these
// routes do no work per request.

const TYPE_LABELS: Record<PlaceType, string> = {
  historic_site: "Historic sites",
  restaurant: "Restaurants",
  experience: "Experiences",
  museum: "Museums",
  viewpoint: "Viewpoints",
  cafe: "Cafes",
  neighborhood: "Neighborhoods",
  market: "Markets",
  park: "Parks",
  shop: "Shops",
  other: "Other places",
};

const PACE_LABELS: Record<(typeof PACES)[number], string> = {
  relaxed: "Relaxed",
  balanced: "Balanced",
  packed: "Packed",
};

// Decision: places are copied through the planner's own Place schema with unknown keys stripped,
// so a field added to the normalizer for internal use never reaches the browser by accident.
const PublicPlaceSchema = z.object(PlaceSchema.shape);

function issueCounts(data: AppData): Partial<Record<IssueKind, number>> {
  const counts: Partial<Record<IssueKind, number>> = {};
  for (const issue of data.dataset.issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return counts;
}

/**
 * The start dates a request may use: the planner's accepted years, with the whole trip inside
 * them. The same rule the web form applies, so the two can never disagree.
 */
export function startDateLimits(): { earliest: string; latest: string } {
  return {
    earliest: `${REQUEST_LIMITS.minYear}-01-01`,
    latest: addDays(`${REQUEST_LIMITS.maxYear}-12-31`, -(TRIP_DAYS - 1)),
  };
}

export function buildMeta(data: AppData): MetaResponse {
  const dates = startDateLimits();
  const typeCounts = new Map<PlaceType, number>();
  for (const place of data.dataset.places) {
    typeCounts.set(place.type, (typeCounts.get(place.type) ?? 0) + 1);
  }
  const clock = (window: { earliestStart: number; latestStart: number }) => ({
    earliestStart: formatClock(window.earliestStart),
    latestStart: formatClock(window.latestStart),
  });
  return {
    anchors: data.ctx.anchors.map((anchor) => ({
      id: anchor.id,
      name: anchor.name,
      region: anchor.region,
      placeCount: anchor.placeIds.length,
      centroid: { lat: anchor.centroid.lat, lng: anchor.centroid.lng },
    })),
    interests: [...interestCounts(data.dataset)].map(([tag, count]) => ({
      tag,
      label: tagLabel(tag),
      count,
    })),
    types: PLACE_TYPES.filter((type) => typeCounts.has(type)).map((type) => ({
      type,
      label: TYPE_LABELS[type],
      count: typeCounts.get(type) ?? 0,
    })),
    priceLevels: ([1, 2, 3, 4] as const).map((level) => ({ level, label: "€".repeat(level) })),
    tripDays: TRIP_DAYS,
    paces: PACES.map((id) => ({
      id,
      label: PACE_LABELS[id],
      maxVisits: PACE[id].maxVisits,
      dayStart: formatClock(PACE[id].dayStart),
      dayEnd: formatClock(PACE[id].dayEnd),
    })),
    meals: { lunch: clock(MEALS.lunch), dinner: clock(MEALS.dinner) },
    limits: {
      maxInterests: REQUEST_LIMITS.maxInterests,
      maxMustInclude: REQUEST_LIMITS.maxMustInclude,
      maxExclude: REQUEST_LIMITS.maxExclude,
      maxAnchors: MAX_ANCHORS_PER_TRIP,
      notesMaxChars: REQUEST_LIMITS.notesMaxChars,
      maxBodyBytes: REQUEST_LIMITS.maxBodyBytes,
      earliestStartDate: dates.earliest,
      latestStartDate: dates.latest,
    },
    issueCounts: issueCounts(data),
    dataSummary: data.dataset.summary,
    dataVersion: dataVersionOf(data),
  };
}

const versions = new WeakMap<AppData, string>();

/**
 * The fingerprint of the places /api/places serves, as the browser computes it over the places it
 * loaded (the planner's dataVersion). A saved trip carries it, so the page can tell whether the
 * trip's times still hold with its data. Computed once per dataset.
 */
export function dataVersionOf(data: AppData): string {
  let version = versions.get(data);
  if (version === undefined) {
    version = dataVersion(buildPlacesPayload(data).places);
    versions.set(data, version);
  }
  return version;
}

export function buildPlacesPayload(data: AppData): PlacesResponse {
  const places = data.dataset.places.map((place) => PublicPlaceSchema.parse(place));
  const chips: PlacesResponse["chips"] = {};
  const approximateLocation: string[] = [];
  for (const place of data.dataset.places) {
    const notes = placeNotes(place);
    chips[place.id] = notes;
    if (notes.some((note) => note.kind === "approximate_location")) {
      approximateLocation.push(place.id);
    }
  }
  return { places, chips, approximateLocation };
}

export function buildDataIssuesPayload(data: AppData): DataIssuesResponse {
  const { dataset } = data;
  return {
    totals: { ...dataset.summary.totals, byKind: issueCounts(data) },
    issues: dataset.issues,
    excluded: dataset.excluded,
    summary: dataset.summary,
  };
}
