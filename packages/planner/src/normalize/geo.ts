import { ITALY_BBOX } from "../config";
import type { DataIssue, Normalized } from "../types";
import { makeIssue } from "./issue";

// Coordinates for one record: numbers (or numeric text) inside Italy's bounding box. Swapped
// pairs are swapped back. Anything else is null here and repaired from sibling places in
// locations.ts, or the record is excluded.

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PointValue extends LatLng {
  source: "listed" | "swapped";
}

const EARTH_RADIUS_KM = 6371;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Median of a non-empty list (mean of the middle two for even lengths). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  return ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

/** Median latitude and longitude: robust to one wrong point in a small group. */
export function medianCentroid(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  return { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) };
}

/** True when the point is inside Italy's bounding box. */
export function insideItaly(point: LatLng): boolean {
  return (
    point.lat >= ITALY_BBOX.minLat &&
    point.lat <= ITALY_BBOX.maxLat &&
    point.lng >= ITALY_BBOX.minLng &&
    point.lng <= ITALY_BBOX.maxLng
  );
}

/** A finite number from a number or numeric text; `fromText` says which. */
function toCoordinate(raw: unknown): { value: number; fromText: boolean } | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, fromText: false } : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? { value, fromText: true } : null;
}

/** Normalizes latitude and longitude of one record. Pure; never throws. */
export function normalizePoint(
  raw: { latitude: unknown; longitude: unknown },
  context: { placeId: string },
): Normalized<PointValue | null> {
  const target = { placeId: context.placeId, field: "latitude,longitude" };
  const rawPair = [raw.latitude, raw.longitude];
  const lat = toCoordinate(raw.latitude);
  const lng = toCoordinate(raw.longitude);
  const issues: DataIssue[] = [];
  if (lat === null || lng === null) {
    const detail = "Latitude or longitude missing or not a finite number";
    const action =
      "Location repaired from nearby places in the same city, or the place is excluded";
    return { value: null, issues: [makeIssue(target, "coords_missing", rawPair, detail, action)] };
  }
  if (lat.fromText || lng.fromText) {
    issues.push(
      makeIssue(target, "coords_format", rawPair, "Coordinates given as text", "Read as numbers"),
    );
  }
  const point = { lat: lat.value, lng: lng.value };
  if (insideItaly(point)) return { value: { ...point, source: "listed" }, issues };

  const swapped = { lat: point.lng, lng: point.lat };
  if (insideItaly(swapped)) {
    const detail = "Latitude and longitude are swapped";
    issues.push(makeIssue(target, "coords_swapped", rawPair, detail, "Swapped back"));
    return { value: { ...swapped, source: "swapped" }, issues };
  }
  const detail = `(${point.lat}, ${point.lng}) is outside Italy`;
  const action = "Location repaired from nearby places in the same city, or the place is excluded";
  issues.push(makeIssue(target, "coords_out_of_bounds", rawPair, detail, action));
  return { value: null, issues };
}
