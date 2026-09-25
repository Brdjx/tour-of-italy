import { describe, expect, it } from "vitest";
import { lngLatBounds, type MapPoint, routeData } from "../lib/mapPoints";
import {
  BASEMAP_SOURCE,
  type ColorScheme,
  GLYPHS_PATH,
  mapStyle,
  mapUrls,
  markerColors,
  PALETTES,
  ROUTE_SOURCE,
  TILES_PATH,
} from "../lib/mapStyle";

// The day map's style is hand-written for the Protomaps basemap. These checks catch the mistakes
// MapLibre only reports at runtime, where the map would silently draw nothing: a layer on a
// source that does not exist, a source layer the tiles do not have, a palette that drifts from
// the page.

const ORIGIN = "https://italy-planner.brdjx.com";
const SCHEMES: ColorScheme[] = ["light", "dark"];
// The source layers of the Protomaps basemap, schema v4.
const PROTOMAPS_LAYERS = [
  "boundaries",
  "buildings",
  "earth",
  "landcover",
  "landuse",
  "places",
  "pois",
  "roads",
  "water",
];

function point(number: number, lat: number, lng: number): MapPoint {
  return {
    number,
    placeId: `place_${number}`,
    name: `Stop ${number}`,
    lat,
    lng,
    approximate: false,
    start: 540,
    end: 600,
    role: "visit",
  };
}

const EMPTY = routeData([]);

function layer(scheme: ColorScheme, id: string) {
  const found = mapStyle(scheme, ORIGIN, EMPTY).layers.find((entry) => entry.id === id);
  if (!found) throw new Error(`No layer ${id}`);
  return found;
}

describe("mapStyle", () => {
  it.each(SCHEMES)("only draws from sources and source layers that exist (%s)", (scheme) => {
    const style = mapStyle(scheme, ORIGIN, EMPTY);
    const sources = Object.keys(style.sources);
    expect(sources).toEqual([BASEMAP_SOURCE, ROUTE_SOURCE]);
    for (const entry of style.layers) {
      if (entry.type === "background") continue;
      expect(sources, entry.id).toContain(entry.source);
      if (entry.source === BASEMAP_SOURCE) {
        expect(PROTOMAPS_LAYERS, entry.id).toContain(entry["source-layer"]);
      }
    }
  });

  it("gives every layer a unique id and the same layers in both schemes", () => {
    const light = mapStyle("light", ORIGIN, EMPTY).layers.map((entry) => entry.id);
    const dark = mapStyle("dark", ORIGIN, EMPTY).layers.map((entry) => entry.id);
    expect(new Set(light).size).toBe(light.length);
    expect(dark).toEqual(light);
  });

  it("paints land in the page's own colour: white paper in light, ink in dark", () => {
    expect(layer("light", "land").paint).toEqual({ "background-color": "#ffffff" });
    expect(layer("dark", "land").paint).toEqual({ "background-color": "#11110f" });
    expect(PALETTES.light.label).toBe("#6a6a63");
    expect(PALETTES.dark.label).toBe("#a3a197");
    expect(PALETTES.light.road).toBe("#dcdad3");
    expect(PALETTES.dark.road).toBe("#34332d");
  });

  it("draws the route last: ink 3 px on a 5 px paper casing", () => {
    for (const scheme of SCHEMES) {
      const ids = mapStyle(scheme, ORIGIN, EMPTY).layers.map((entry) => entry.id);
      expect(ids.slice(-2)).toEqual(["route-casing", "route"]);
      const { ink, paper } = PALETTES[scheme];
      expect(layer(scheme, "route-casing").paint).toEqual({
        "line-color": paper,
        "line-width": 5,
      });
      expect(layer(scheme, "route").paint).toEqual({ "line-color": ink, "line-width": 3 });
    }
    expect(PALETTES.light).toMatchObject({ ink: "#11110f", paper: "#ffffff" });
    expect(PALETTES.dark).toMatchObject({ ink: "#f3f2ec", paper: "#11110f" });
  });

  it("gives the stop markers the route's ink and paper", () => {
    for (const scheme of SCHEMES) {
      const palette = PALETTES[scheme];
      expect(markerColors(palette)).toEqual({
        "--map-ink": palette.ink,
        "--map-paper": palette.paper,
      });
    }
  });

  it("carries the day's route as the route source", () => {
    const route = routeData([point(1, 41.89, 12.49), point(2, 41.9, 12.47)]);
    const source = mapStyle("light", ORIGIN, route).sources[ROUTE_SOURCE];
    expect(source).toEqual({ type: "geojson", data: route });
  });

  it("reads tiles and glyphs from this site, with absolute URLs", () => {
    expect(TILES_PATH).toMatch(/^\/tiles\/italy-\d{8}\.pmtiles$/);
    const urls = mapUrls(ORIGIN);
    expect(urls.tiles).toBe(`pmtiles://${ORIGIN}${TILES_PATH}`);
    expect(urls.glyphs).toBe(`${ORIGIN}${GLYPHS_PATH}`);
    const style = mapStyle("dark", ORIGIN, EMPTY);
    expect(style.glyphs).toBe(urls.glyphs);
    expect(style.sources[BASEMAP_SOURCE]).toEqual({ type: "vector", url: urls.tiles });
  });
});

describe("routeData and lngLatBounds", () => {
  const stops = [point(1, 41.89, 12.49), point(2, 41.91, 12.46), point(3, 41.9, 12.5)];

  it("joins the stops in visiting order with straight segments, as [lng, lat]", () => {
    expect(routeData(stops).features).toEqual([
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [12.49, 41.89],
            [12.46, 41.91],
            [12.5, 41.9],
          ],
        },
      },
    ]);
  });

  it("draws no route for a single stop or none", () => {
    expect(routeData(stops.slice(0, 1)).features).toEqual([]);
    expect(routeData([]).features).toEqual([]);
  });

  it("gives the bounds west-south then east-north, and none for an empty day", () => {
    expect(lngLatBounds(stops)).toEqual([
      [12.46, 41.89],
      [12.5, 41.91],
    ]);
    expect(lngLatBounds([])).toBeNull();
  });
});
