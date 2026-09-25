import type { Box } from "../../lib/mapGeometry";
import type { MapPoint } from "../../lib/mapPoints";
import { MARKER_MAX_NUDGE } from "./spread";

// How the map frames a day's stops.

/** Room around the stops, in px: a stop disc is 28 px across and must never touch the edge. */
export const FIT_PADDING = 40;
/** A single stop, or stops a street apart, are shown at street level and no closer. */
export const FIT_MAX_ZOOM = 15;
/** The camera move when the day or its stops change. */
export const CAMERA_MS = 700;
/** The full-screen map grows out of the page's map over this long, and shrinks back quicker. */
export const GROW_MS = 450;
export const SHRINK_MS = 340;
/** Under reduced motion the full-screen map fades in and out instead. */
export const FADE_IN_MS = 180;
export const FADE_OUT_MS = 160;

/** The Expand map pill: 44 px, 8 px in from the top right corner of the page's map. */
export const EXPAND_INSET = 8;
export const EXPAND_SIZE = 44;
/**
 * How far a stop's disc can reach from its place: its 14 px radius, the largest nudge that keeps
 * crowded numbers apart (map/spread.ts), and 4 px of air.
 */
export const DISC_REACH = 14 + MARKER_MAX_NUDGE + 4;
/** Top padding that keeps every disc clear of the Expand pill, nudged or not. */
export const EXPAND_CLEAR = EXPAND_INSET + EXPAND_SIZE + DISC_REACH;

/** The Expand pill's box when the page's map is `region` (in the map's own px). */
export function expandZone(region: Box): Box {
  return {
    left: region.left + region.width - EXPAND_INSET - EXPAND_SIZE,
    top: region.top + EXPAND_INSET,
    width: EXPAND_SIZE,
    height: EXPAND_SIZE,
  };
}

/** Exponential ease-out: fast at first, then settling, like the rest of the page's motion. */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Changes whenever a stop is added, removed, moved or swapped, so the camera refits. */
export function pointsKey(points: readonly MapPoint[]): string {
  return points.map((point) => `${point.placeId}@${point.lat},${point.lng}`).join("|");
}
