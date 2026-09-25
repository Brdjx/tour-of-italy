import type { DayPlan, PlannerContext, StopRole } from "@italy/planner";
import { formatClock } from "./format";
import type { DayView } from "./timetable";

// Markers, route and camera bounds for the day map, numbered in visiting order, and the words a
// marker says about its stop. Kept out of the map component so the numbering, the labels and the
// approximate-location rule are tested without a browser map.

export interface MapPoint {
  number: number; // 1-based visiting order, matches the timetable
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  approximate: boolean; // repaired coordinates: drawn as a paper disc with a dashed ring
  start: number; // the stop's times, minutes after midnight, as the board shows them
  end: number;
  role: StopRole;
}

/** Anything with a position: bounds and the route need nothing else. */
export type LatLng = Pick<MapPoint, "lat" | "lng">;

export function mapPoints(day: DayPlan, ctx: PlannerContext): MapPoint[] {
  const points: MapPoint[] = [];
  day.stops.forEach((stop, index) => {
    const place = ctx.placesById.get(stop.placeId);
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return;
    points.push({
      number: index + 1,
      placeId: place.id,
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      approximate: place.locationSource !== "listed" && place.locationSource !== "swapped",
      start: stop.start,
      end: stop.end,
      role: stop.role,
    });
  });
  return points;
}

/** South-west and north-east corners around the points, or null when there are none. */
export function boundsOf(points: readonly LatLng[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
    west = Math.min(west, point.lng);
    east = Math.max(east, point.lng);
  }
  return [
    [south, west],
    [north, east],
  ];
}

const ROLE_WORD: Record<StopRole, string> = { visit: "Visit", lunch: "Lunch", dinner: "Dinner" };

/** "Visit", "Lunch" or "Dinner": what the stop is for, as the marker's popup says it. */
export function roleWord(role: StopRole): string {
  return ROLE_WORD[role];
}

/** "10:50 to 12:50", the stop's times as a line of text. */
export function stopTimes(point: Pick<MapPoint, "start" | "end">): string {
  return `${formatClock(point.start)} to ${formatClock(point.end)}`;
}

/**
 * The marker's accessible name: "Stop 2, Borghese Gallery, 10:50 to 12:50, lunch". A plain
 * visit says nothing more; a meal says which, and a repaired location says it is approximate.
 */
export function stopLabel(point: MapPoint): string {
  const parts = [`Stop ${point.number}`, point.name, stopTimes(point)];
  if (point.role !== "visit") parts.push(point.role);
  if (point.approximate) parts.push("approximate location");
  return parts.join(", ");
}

/** "Day 1, Fri 9 Oct, Rome": the full-screen map's heading. */
export function mapDayTitle(view: Pick<DayView, "index" | "tabLabel" | "anchorName">): string {
  return `Day ${view.index + 1}, ${view.tabLabel}, ${view.anchorName}`;
}

/** "6 stops, numbered in visiting order", under that heading. */
export function stopCountText(count: number): string {
  return `${count} ${count === 1 ? "stop" : "stops"}, numbered in visiting order`;
}

/** The route as GeoJSON: straight segments in visiting order, or nothing for a single stop. */
export interface RouteData {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: Record<string, never>;
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }[];
}

export function routeData(points: readonly LatLng[]): RouteData {
  if (points.length < 2) return { type: "FeatureCollection", features: [] };
  const coordinates = points.map((point): [number, number] => [point.lng, point.lat]);
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }],
  };
}

/** boundsOf in MapLibre's order: [[west, south], [east, north]], or null when there are none. */
export function lngLatBounds(
  points: readonly LatLng[],
): [[number, number], [number, number]] | null {
  const bounds = boundsOf(points);
  if (!bounds) return null;
  const [[south, west], [north, east]] = bounds;
  return [
    [west, south],
    [east, north],
  ];
}
