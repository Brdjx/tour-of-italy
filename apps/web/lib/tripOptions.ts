import {
  INTEREST_EXCLUDED_TAGS,
  MAX_ANCHORS_PER_TRIP,
  PACE,
  PACES,
  type Pace,
  type PlaceType,
  type PlannerContext,
  type PriceLevel,
  REQUEST_LIMITS,
  TRIP_DAYS,
  tagLabel,
} from "@italy/planner";
import type { Meta } from "./apiSchemas";
import { formatClock } from "./format";

// Everything the trip form offers: bases, interests with counts, paces, budgets, limits, and
// the place list for the must-see and skip pickers. Built from /api/meta when it parses, and
// from the places themselves otherwise, so the form works with the API half deployed.

export interface AnchorOption {
  id: string;
  name: string;
  placeCount: number;
}

export interface InterestOption {
  tag: string;
  label: string;
  count: number;
}

export interface PaceOption {
  id: Pace;
  label: string;
  hint: string; // "Up to 5 visits a day, plus lunch and dinner, 09:30 to 22:30"
}

export interface PlaceOption {
  id: string;
  name: string;
  city: string;
  type: PlaceType;
}

export interface TripLimits {
  maxInterests: number;
  maxMustInclude: number;
  maxExclude: number;
  maxAnchors: number;
  notesMaxChars: number;
}

export interface TripOptions {
  tripDays: number;
  anchors: AnchorOption[];
  interests: InterestOption[];
  paces: PaceOption[];
  priceLevels: PriceLevel[];
  places: PlaceOption[];
  limits: TripLimits;
}

const PACE_LABELS: Record<Pace, string> = {
  relaxed: "Relaxed",
  balanced: "Balanced",
  packed: "Packed",
};

export const LIMITS: TripLimits = {
  maxInterests: REQUEST_LIMITS.maxInterests,
  maxMustInclude: REQUEST_LIMITS.maxMustInclude,
  maxExclude: REQUEST_LIMITS.maxExclude,
  maxAnchors: MAX_ANCHORS_PER_TRIP,
  notesMaxChars: REQUEST_LIMITS.notesMaxChars,
};

function paceOptions(): PaceOption[] {
  return PACES.map((id) => {
    const pace = PACE[id];
    const window = `${formatClock(pace.dayStart)} to ${formatClock(pace.dayEnd)}`;
    // Decision: "visits", the word the pace limit and its chip use; meals do not count toward it.
    const hint = `Up to ${pace.maxVisits} visits a day, plus lunch and dinner, ${window}`;
    return { id, label: PACE_LABELS[id], hint };
  });
}

/**
 * The parts of the form that need nothing from the API (trip length, paces, limits), so the
 * start date, the pace and "Plan my trip" work before the places arrive.
 */
export type PrimaryOptions = Pick<TripOptions, "tripDays" | "paces" | "limits">;

export const PRIMARY_OPTIONS: PrimaryOptions = {
  tripDays: TRIP_DAYS,
  paces: paceOptions(),
  limits: LIMITS,
};

/** Places for the pickers, sorted by name so the list reads like an index. */
function placeOptions(ctx: PlannerContext): PlaceOption[] {
  const options = ctx.places.map((place) => ({
    id: place.id,
    name: place.name,
    city: place.city,
    type: place.type,
  }));
  return options.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Interests counted from the places, most common first, excluding non-interest tags. */
export function interestsFromPlaces(ctx: PlannerContext): InterestOption[] {
  const counts = new Map<string, number>();
  for (const place of ctx.places) {
    for (const tag of place.tags) {
      if (INTEREST_EXCLUDED_TAGS.includes(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const options = [...counts].map(([tag, count]) => ({ tag, label: tagLabel(tag), count }));
  return options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"));
}

function baseOptions(ctx: PlannerContext): TripOptions {
  return {
    ...PRIMARY_OPTIONS,
    anchors: ctx.anchors.map((anchor) => ({
      id: anchor.id,
      name: anchor.name,
      placeCount: anchor.placeIds.length,
    })),
    interests: interestsFromPlaces(ctx),
    priceLevels: [1, 2, 3, 4],
    places: placeOptions(ctx),
  };
}

/**
 * Form options. Meta wins for bases and interests when present, but only for entries the
 * loaded places know about: a base or tag the browser cannot plan with would fail the offline
 * fallback and the share-link rebuild, so it is not offered.
 */
export function buildTripOptions(ctx: PlannerContext, meta: Meta | null): TripOptions {
  const derived = baseOptions(ctx);
  if (!meta) return derived;
  const knownTags = new Set(derived.interests.map((interest) => interest.tag));
  const interests = meta.interests
    .filter((interest) => knownTags.has(interest.tag))
    .map((interest) => ({
      tag: interest.tag,
      label: interest.label ?? tagLabel(interest.tag),
      count: interest.count,
    }));
  const anchors = meta.anchors
    .filter((anchor) => ctx.anchorById.has(anchor.id))
    .map((anchor) => ({
      id: anchor.id,
      name: anchor.name,
      placeCount: anchor.placeCount ?? ctx.anchorById.get(anchor.id)?.placeIds.length ?? 0,
    }));
  // Decision: an empty list after filtering means meta and places disagree completely; the
  // places are what the browser plans with, so they win.
  return {
    ...derived,
    interests: interests.length > 0 ? interests : derived.interests,
    anchors: anchors.length > 0 ? anchors : derived.anchors,
  };
}
