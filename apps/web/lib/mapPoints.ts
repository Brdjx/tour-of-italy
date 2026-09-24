import type { DayPlan, PlannerContext } from "@italy/planner";

// Markers, route and camera bounds for the day map, numbered in visiting order. Kept out of the
// map component so the numbering and the approximate-location rule are tested without a browser
// map.

export interface MapPoint {
  number: number; // 1-based visiting order, matches the timetable
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  approximate: boolean; // repaired coordinates: drawn as a paper disc with a dashed ring
}

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
    });
  });
  return points;
}

/** South-west and north-east corners around the points, or null when there are none. */
export function boundsOf(points: readonly MapPoint[]): [[number, number], [number, number]] | null {
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

/** Marker HTML for one stop. Only a number goes in, so nothing from the data is injected. */
export function markerHtml(point: Pick<MapPoint, "number" | "approximate">): string {
  const number = Math.max(0, Math.floor(point.number));
  const variant = point.approximate ? "map-marker map-marker--approximate" : "map-marker";
  return `<span class="${variant}" aria-hidden="true">${number}</span>`;
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

export function routeData(points: readonly MapPoint[]): RouteData {
  if (points.length < 2) return { type: "FeatureCollection", features: [] };
  const coordinates = points.map((point): [number, number] => [point.lng, point.lat]);
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }],
  };
}

/** boundsOf in MapLibre's order: [[west, south], [east, north]], or null when there are none. */
export function lngLatBounds(
  points: readonly MapPoint[],
): [[number, number], [number, number]] | null {
  const bounds = boundsOf(points);
  if (!bounds) return null;
  const [[south, west], [north, east]] = bounds;
  return [
    [west, south],
    [east, north],
  ];
}
