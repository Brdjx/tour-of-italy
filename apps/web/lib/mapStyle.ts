import type { MapOptions } from "maplibre-gl";
import type { RouteData } from "./mapPoints";

// The day map's look: a hand-written MapLibre style for the Protomaps basemap (schema v4),
// drawn from a vector tile archive this site serves itself. It is quiet on purpose, so the
// route and the numbered stops are the content: paper land, tinted water, warm parks, faint
// buildings, roads as hairlines and a few labels (towns, neighbourhoods, main streets). Two
// palettes follow the page, light on white paper and dark on ink.
// Only types come from maplibre-gl here, so this file adds nothing to the page's main bundle.

/**
 * The tile archive: the Protomaps daily build of 2026-09-24, cut with `pmtiles extract` into
 * three zoom bands: the whole trip area to zoom 10; up to zoom 12, also a band from each base
 * to its day trips; and up to zoom 15, about 5 km around every place and 12 km around each
 * base city. It is not in git (140 MB); production serves it from the site bucket. A new build
 * gets a new file name, so a browser never mixes tiles from two builds.
 */
export const TILES_PATH = "/tiles/italy-20260924.pmtiles";
/** Glyph ranges for the label fonts, self-hosted with their license (public/map/fonts). */
export const GLYPHS_PATH = "/map/fonts/{fontstack}/{range}.pbf";
/**
 * MapLibre's worker, copied from maplibre-gl/dist into public/map/maplibre with the file it
 * imports. test/mapAssets.test.ts fails when the copies no longer match the installed package.
 */
// Decision: a copy served from the site instead of a bundler asset. The worker imports
// maplibre-gl-shared.mjs by a relative path, so the two files must sit side by side, and the
// bundler renames every asset it emits. A same-origin worker also keeps the CSP at
// worker-src 'self', with no blob: workers.
export const WORKER_PATH = "/map/maplibre/maplibre-gl-worker.mjs";

export const BASEMAP_SOURCE = "basemap";
export const ROUTE_SOURCE = "route";

const REGULAR = ["Noto Sans Regular"];
const MEDIUM = ["Noto Sans Medium"];

export type ColorScheme = "light" | "dark";

export interface MapPalette {
  land: string;
  park: string;
  water: string;
  building: string;
  road: string; // hairlines
  roadMajor: string;
  label: string;
  labelHalo: string;
  ink: string; // the route and the stop discs
  paper: string; // the route's casing, the ring around each disc and the number on it
}

// Decision: land is the page itself (white paper, or ink in dark mode), so the map reads as
// part of the page rather than a picture set into it. Water is the one cool tint, just enough
// to find the Tiber, the Arno, the canals and the lagoon.
export const PALETTES: Record<ColorScheme, MapPalette> = {
  light: {
    land: "#ffffff",
    park: "#f6f5f0",
    water: "#e3e7e7",
    building: "#f2f1ec",
    road: "#dcdad3",
    roadMajor: "#c9c7bf",
    label: "#6a6a63",
    labelHalo: "#ffffff",
    ink: "#11110f",
    paper: "#ffffff",
  },
  dark: {
    land: "#11110f",
    park: "#171714",
    water: "#1d2021",
    building: "#1b1b18",
    road: "#34332d",
    roadMajor: "#4a4942",
    label: "#a3a197",
    labelHalo: "#11110f",
    ink: "#f3f2ec",
    paper: "#11110f",
  },
};

/** The style object MapLibre takes (its type is not exported by name). */
export type MapStyle = Exclude<MapOptions["style"], string | undefined>;
type Layer = MapStyle["layers"][number];

const PARK_KINDS = [
  "park",
  "garden",
  "national_park",
  "nature_reserve",
  "forest",
  "wood",
  "grass",
  "grassland",
  "meadow",
  "golf_course",
  "cemetery",
  "playground",
  "recreation_ground",
];

/** Where the styles fetch tiles and glyphs; absolute, so a request never depends on its caller. */
export function mapUrls(origin: string): { tiles: string; glyphs: string } {
  return { tiles: `pmtiles://${origin}${TILES_PATH}`, glyphs: `${origin}${GLYPHS_PATH}` };
}

/** CSS custom properties for the HTML stop markers, so they match the route drawn on the map. */
export function markerColors(palette: MapPalette): Record<"--map-ink" | "--map-paper", string> {
  return { "--map-ink": palette.ink, "--map-paper": palette.paper };
}

function basemapLayers(p: MapPalette): Layer[] {
  const labelPaint = {
    "text-color": p.label,
    "text-halo-color": p.labelHalo,
    "text-halo-width": 1.5,
  };
  return [
    // Decision: the background is land, not sea. The archive only has street detail near the
    // trip's places, and a tile it does not have then shows as blank land instead of open sea.
    { id: "land", type: "background", paint: { "background-color": p.land } },
    {
      id: "park",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PARK_KINDS]],
      paint: { "fill-color": p.park },
    },
    {
      id: "water",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "water",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": p.water },
    },
    {
      id: "waterway",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "water",
      minzoom: 11,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": p.water,
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 11, 0.5, 16, 3],
      },
    },
    {
      id: "building",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "buildings",
      minzoom: 14,
      filter: ["==", ["get", "kind"], "building"],
      paint: {
        "fill-color": p.building,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1],
      },
    },
    {
      // Decision: pedestrian streets from zoom 13 and footways and steps from zoom 14, with the
      // minor roads. The old centres of Florence, Rome and Venice are mapped largely as
      // pedestrian ways and footways, and without them the heart of a day's map is blank.
      // Sidewalks and crossings are left out: they draw every street twice.
      id: "road-path",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "roads",
      minzoom: 13,
      filter: [
        "all",
        ["==", ["get", "kind"], "path"],
        [
          "any",
          ["==", ["get", "kind_detail"], "pedestrian"],
          [
            "all",
            ["in", ["get", "kind_detail"], ["literal", ["footway", "steps", "path"]]],
            [">=", ["zoom"], 14],
          ],
        ],
      ],
      paint: {
        "line-color": p.road,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 17, 1.25],
      },
    },
    {
      id: "road-minor",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "roads",
      minzoom: 12,
      filter: ["in", ["get", "kind"], ["literal", ["minor_road", "other"]]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": p.road,
        "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 0.5, 17, 2],
      },
    },
    {
      id: "road-major",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "roads",
      minzoom: 7,
      filter: ["in", ["get", "kind"], ["literal", ["major_road", "highway"]]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": p.roadMajor,
        "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 7, 0.5, 12, 0.9, 17, 3],
      },
    },
    {
      id: "label-street",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "roads",
      minzoom: 14,
      filter: ["all", ["==", ["get", "kind"], "major_road"], ["has", "name"]],
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "name"],
        "text-font": REGULAR,
        "text-size": 11,
      },
      paint: labelPaint,
    },
    {
      id: "label-neighbourhood",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "places",
      minzoom: 12,
      filter: [
        "all",
        ["in", ["get", "kind"], ["literal", ["neighbourhood", "macrohood"]]],
        ["<=", ["get", "min_zoom"], ["zoom"]],
      ],
      layout: {
        "text-field": ["get", "name"],
        "text-font": REGULAR,
        "text-size": 11,
        "text-letter-spacing": 0.04,
        "text-max-width": 7,
        "symbol-sort-key": ["get", "min_zoom"],
      },
      paint: labelPaint,
    },
    {
      // Cities, towns and villages. Protomaps also has "localities" (a square, a hill), which
      // read as towns at this size and are left out.
      id: "label-town",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "places",
      filter: [
        "all",
        ["==", ["get", "kind"], "locality"],
        ["in", ["get", "kind_detail"], ["literal", ["city", "town", "village"]]],
        ["<=", ["get", "min_zoom"], ["+", ["zoom"], 1]],
      ],
      layout: {
        "text-field": ["get", "name"],
        "text-font": MEDIUM,
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,
          ["match", ["get", "kind_detail"], "city", 12, 10],
          13,
          ["match", ["get", "kind_detail"], "city", 16, 13],
        ],
        "text-max-width": 8,
        "symbol-sort-key": ["get", "min_zoom"],
      },
      paint: labelPaint,
    },
  ];
}

function routeLayers(p: MapPalette): Layer[] {
  const layout = { "line-join": "round", "line-cap": "round" } as const;
  return [
    {
      id: "route-casing",
      type: "line",
      source: ROUTE_SOURCE,
      layout,
      paint: { "line-color": p.paper, "line-width": 5 },
    },
    {
      id: "route",
      type: "line",
      source: ROUTE_SOURCE,
      layout,
      paint: { "line-color": p.ink, "line-width": 3 },
    },
  ];
}

/**
 * The whole style for one colour scheme. The route is part of the style, so switching between
 * light and dark (MapLibre diffs the two styles) keeps it without drawing it again by hand.
 */
export function mapStyle(scheme: ColorScheme, origin: string, route: RouteData): MapStyle {
  const palette = PALETTES[scheme];
  const urls = mapUrls(origin);
  return {
    version: 8,
    glyphs: urls.glyphs,
    sources: {
      [BASEMAP_SOURCE]: { type: "vector", url: urls.tiles },
      [ROUTE_SOURCE]: { type: "geojson", data: route },
    },
    layers: [...basemapLayers(palette), ...routeLayers(palette)],
  };
}
