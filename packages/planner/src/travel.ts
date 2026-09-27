import { BOAT_ONLY_ISLANDS, DINNER_RETURN_GRACE_MIN, TRAVEL, WATER_BUS_AREAS } from "./config";
import { haversineKm, type LatLng } from "./normalize/geo";
import type { StopRole } from "./types";

// Straight-line travel model: distance by haversine, then one of four bands (walk, local,
// regional, intercity) turns kilometers into minutes, rounded up to TRAVEL.roundToMin. Two water
// rules refine it in Venice: a leg to or from a boat-only island is never a walk, and a local leg
// inside the lagoon is labeled "by vaporetto" instead of "by taxi or bus".
// Decision: a documented straight-line model instead of a routing API. It is deterministic, free,
// runs in the browser, and is good enough to prevent impossible days.

export type { LatLng };
export { haversineKm };

/** How a leg is travelled. Each mode is one band in TRAVEL (config.ts). */
export type TravelMode = "walk" | "local" | "regional" | "intercity";

/** One leg between two points, computed once for display and scheduling. */
export interface TravelLeg {
  km: number; // straight-line distance
  minutes: number; // travel time, a multiple of TRAVEL.roundToMin
  mode: TravelMode; // band the distance falls in
  label: string; // "12 min walk", "25 min by taxi or bus", ...
}

const BANDS: Record<TravelMode, { overheadMin: number; kmh: number }> = {
  walk: { overheadMin: 0, kmh: TRAVEL.walkKmh },
  local: { overheadMin: TRAVEL.localOverheadMin, kmh: TRAVEL.localKmh },
  regional: { overheadMin: TRAVEL.regionalOverheadMin, kmh: TRAVEL.regionalKmh },
  intercity: { overheadMin: TRAVEL.intercityOverheadMin, kmh: TRAVEL.intercityKmh },
};

const MODE_WORDS: Record<TravelMode, string> = {
  walk: "walk",
  local: "by taxi or bus",
  regional: "by train or car",
  intercity: "by high-speed train",
};

/** Label for a leg of zero minutes: two places on the same spot. */
export const SAME_SPOT_LABEL = "Same spot, no travel";

function requireDistance(km: number): void {
  if (!Number.isFinite(km) || km < 0) {
    throw new RangeError(`Travel needs a finite, non-negative distance, got ${km}`);
  }
}

/**
 * The band for a distance. A distance exactly on a band edge belongs to the lower band: 1.5 km is
 * a walk, 20 km is local, 150 km is regional. Throws RangeError for NaN or negative input.
 */
// Decision: the bands are not monotonic at their edges (a 1.6 km taxi ride is quicker than a
// 1.5 km walk, and a 151 km high-speed trip is quicker than a 150 km regional one). That is the
// real trade-off between modes, and the validator uses the same function, so plans agree.
export function travelModeForKm(km: number): TravelMode {
  requireDistance(km);
  if (km <= TRAVEL.walkMaxKm) return "walk";
  if (km <= TRAVEL.localMaxKm) return "local";
  if (km <= TRAVEL.regionalMaxKm) return "regional";
  return "intercity";
}

/** Travel minutes for a distance, rounded up to TRAVEL.roundToMin. Zero km is zero minutes. */
export function travelMinutesForKm(km: number): number {
  return minutesByMode(km, travelModeForKm(km));
}

/** Minutes for a distance travelled in a given band, rounded up to TRAVEL.roundToMin. */
function minutesByMode(km: number, mode: TravelMode): number {
  const band = BANDS[mode];
  const raw = band.overheadMin + (km / band.kmh) * 60;
  // Decision: round the raw minutes to a millionth first, so float noise (1.5 km at 4.5 km/h is
  // 19.999999999999996) cannot push an exact multiple of 5 up to the next step.
  const cleaned = Math.round(raw * 1e6) / 1e6;
  const step = TRAVEL.roundToMin;
  return Math.ceil(cleaned / step) * step;
}

/** Orders two points so a and b give the same float arithmetic in either order. */
function canonicalPair(a: LatLng, b: LatLng): [LatLng, LatLng] {
  if (a.lat < b.lat || (a.lat === b.lat && a.lng <= b.lng)) return [a, b];
  return [b, a];
}

/** Straight-line distance in km, identical for (a, b) and (b, a). */
function legKm(a: LatLng, b: LatLng): number {
  const [first, second] = canonicalPair(a, b);
  return haversineKm(first, second);
}

/** The boat-only island a point is on, or null. */
function islandOf(point: LatLng): string | null {
  for (const island of BOAT_ONLY_ISLANDS) {
    // A cheap latitude test first: most points are nowhere near the lagoon.
    if (Math.abs(point.lat - island.lat) > 0.05) continue;
    if (haversineKm(point, island) <= island.radiusKm) return island.name;
  }
  return null;
}

/** The band for a leg: by distance, except that a walk onto or off a boat-only island is a boat. */
function legMode(a: LatLng, b: LatLng, km: number): TravelMode {
  const mode = travelModeForKm(km);
  if (mode === "walk" && islandOf(a) !== islandOf(b)) return "local";
  return mode;
}

/** The words for a local leg: the water bus inside a lagoon area, else "by taxi or bus". */
function localWords(a: LatLng, b: LatLng): string {
  for (const area of WATER_BUS_AREAS) {
    if (inBox(a, area.box) && inBox(b, area.box)) return area.words;
  }
  return MODE_WORDS.local;
}

function inBox(point: LatLng, box: (typeof WATER_BUS_AREAS)[number]["box"]): boolean {
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lng >= box.minLng &&
    point.lng <= box.maxLng
  );
}

/** Travel minutes between two points. Symmetric. Throws RangeError on non-finite coordinates. */
export function travelMinutes(a: LatLng, b: LatLng): number {
  const km = legKm(a, b);
  return minutesByMode(km, legMode(a, b, km));
}

/** The band a leg between two points falls in. Symmetric. */
export function travelMode(a: LatLng, b: LatLng): TravelMode {
  const km = legKm(a, b);
  return legMode(a, b, km);
}

/**
 * Minutes as display text: "12 min", "1 h", "1 h 40 min". Throws RangeError for negative,
 * fractional, or non-finite input.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new RangeError(`formatDuration needs whole non-negative minutes, got ${minutes}`);
  }
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Label for a number of minutes by a mode: "12 min walk", "2 h 10 min by high-speed train". */
export function travelLabelFor(minutes: number, mode: TravelMode): string {
  if (minutes === 0) return SAME_SPOT_LABEL;
  return `${formatDuration(minutes)} ${MODE_WORDS[mode]}`;
}

/** Display label for the leg between two points. */
export function travelLabel(a: LatLng, b: LatLng): string {
  return travelLeg(a, b).label;
}

/**
 * Label for `minutes` of travel on the leg between two points, in that leg's mode and words: a
 * local leg inside the lagoon is "by vaporetto", every other label is travelLabelFor's.
 */
// Decision: the minutes come from the caller, because a planned stop keeps the minutes the
// scheduler gave it; only the words come from the two points, so the page and travelLeg agree.
export function travelLabelBetween(minutes: number, a: LatLng, b: LatLng): string {
  return legLabel(minutes, travelMode(a, b), a, b);
}

function legLabel(minutes: number, mode: TravelMode, a: LatLng, b: LatLng): string {
  if (mode === "local" && minutes > 0) return `${formatDuration(minutes)} ${localWords(a, b)}`;
  return travelLabelFor(minutes, mode);
}

/** Distance, minutes, mode, and label for one leg, all from a single distance computation. */
export function travelLeg(a: LatLng, b: LatLng): TravelLeg {
  const km = legKm(a, b);
  const mode = legMode(a, b, km);
  const minutes = minutesByMode(km, mode);
  return { km, minutes, mode, label: legLabel(minutes, mode, a, b) };
}

/**
 * The latest time the trip back to the base may end when the day's last stop has `role`: the day
 * window's end, or DINNER_RETURN_GRACE_MIN later after a dinner. The scheduler, the planner's
 * look-ahead, and the validator all ask this one function.
 */
export function latestReturn(windowEnd: number, role: StopRole): number {
  return windowEnd + (role === "dinner" ? DINNER_RETURN_GRACE_MIN : 0);
}
