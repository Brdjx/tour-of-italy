// The areas the self-hosted map covers, as two GeoJSON files for `pmtiles extract --region`.
// Run with `pnpm map:regions [outDir]` (default: the current folder), then build-tiles.sh.
//
//   region.geojson       about 5 km around every place and 12 km around each base's centre:
//                        the areas a day's map shows up close (zoom 13 to 15)
//   region-wide.geojson  the circles above plus a band from each base to each of its day trips
//                        more than 8 km away, so the camera never crosses an empty gap (zoom 11-12)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAnchors, buildDataset } from "@italy/planner";

const PLACE_KM = 5;
const BASE_KM = 12;
const DAY_TRIP_MIN_KM = 8; // closer day trips are inside the base's circle already
const BAND_PAD_KM = 4; // how much wider than the straight line a band is on every side
const KM_PER_DEGREE = 111.32;

type Ring = number[][];
type Polygon = Ring[];

/** A 48-sided circle of `km` around a point, as a GeoJSON polygon ([lng, lat] pairs). */
function circle(lat: number, lng: number, km: number, sides = 48): Polygon {
  const dLat = km / KM_PER_DEGREE;
  const dLng = km / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const ring: Ring = [];
  for (let i = 0; i <= sides; i++) {
    const angle = (2 * Math.PI * (i % sides)) / sides;
    ring.push([round(lng + dLng * Math.cos(angle)), round(lat + dLat * Math.sin(angle))]);
  }
  return [ring];
}

/** The rectangle around two points, `padKm` wider on every side. */
function band(a: { lat: number; lng: number }, b: { lat: number; lng: number }): Polygon {
  const dLat = BAND_PAD_KM / KM_PER_DEGREE;
  const dLng = BAND_PAD_KM / (KM_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180));
  const south = Math.min(a.lat, b.lat) - dLat;
  const north = Math.max(a.lat, b.lat) + dLat;
  const west = Math.min(a.lng, b.lng) - dLng;
  const east = Math.max(a.lng, b.lng) + dLng;
  return [
    [
      [round(west), round(south)],
      [round(east), round(south)],
      [round(east), round(north)],
      [round(west), round(north)],
      [round(west), round(south)],
    ],
  ];
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** Straight-line distance in km, good enough to decide what counts as a day trip. */
function roughKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * KM_PER_DEGREE;
  const dLng = (a.lng - b.lng) * KM_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

const outDir = process.argv[2] ?? ".";
const dataset = buildDataset(JSON.parse(readFileSync("data/italy.json", "utf8")));
const anchors = buildAnchors(dataset.places);
const byId = new Map(dataset.places.map((place) => [place.id, place]));

const circles: Polygon[] = [];
for (const place of dataset.places) circles.push(circle(place.lat, place.lng, PLACE_KM));
for (const anchor of anchors) {
  circles.push(circle(anchor.centroid.lat, anchor.centroid.lng, BASE_KM));
}

const bands: Polygon[] = [];
for (const anchor of anchors) {
  for (const id of anchor.placeIds) {
    const place = byId.get(id);
    if (place && roughKm(place, anchor.centroid) > DAY_TRIP_MIN_KM) {
      bands.push(band(anchor.centroid, place));
    }
  }
}

const write = (name: string, polygons: Polygon[]) =>
  writeFileSync(
    join(outDir, name),
    JSON.stringify({ type: "MultiPolygon", coordinates: polygons }),
  );
write("region.geojson", circles);
write("region-wide.geojson", [...circles, ...bands]);
console.log(
  `${circles.length} circles, ${bands.length} day-trip bands, written to ${outDir}/region.geojson and region-wide.geojson`,
);
