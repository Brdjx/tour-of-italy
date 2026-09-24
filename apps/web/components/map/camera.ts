import type { MapPoint } from "../../lib/mapPoints";

// How the map frames a day's stops.

/** Room around the stops, in px: a stop disc is 28 px across and must never touch the edge. */
export const FIT_PADDING = 40;
/** A single stop, or stops a street apart, are shown at street level and no closer. */
export const FIT_MAX_ZOOM = 15;
/** The camera move when the day or its stops change. */
export const CAMERA_MS = 700;

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
