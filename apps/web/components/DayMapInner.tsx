"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { AttributionControl, Map as MapLibreMap, Marker } from "maplibre-gl";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { lngLatBounds, type MapPoint, markerHtml, routeData } from "../lib/mapPoints";
import { BASEMAP_SOURCE, mapStyle, markerColors, PALETTES } from "../lib/mapStyle";
import {
  CAMERA_MS,
  easeOutExpo,
  FIT_MAX_ZOOM,
  FIT_PADDING,
  pointsKey,
  prefersReducedMotion,
} from "./map/camera";
import { MapUnavailable } from "./map/MapUnavailable";
import { setUpMap } from "./map/setup";
import { useColorScheme } from "./map/useColorScheme";

// The MapLibre map itself, loaded only in the browser (see DayMap): the self-hosted vector
// basemap (lib/mapStyle.ts), the route as straight ink segments in visiting order, and one
// numbered HTML marker per stop. When the day or its stops change the camera glides to the new
// stops. It has no keyboard stops of its own: the timetable is its text equivalent, so the map
// stays a visual aid, and the credits it shows are repeated as links under it.

/** Shown on the map; the caption under the map has the same credits as links. */
const CREDITS = "© OpenStreetMap contributors · Protomaps";
/** The tile archive covers the trip's area; the camera cannot leave it. */
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [7.8, 40.9],
  [14, 46.8],
];
const ITALY: { center: [number, number]; zoom: number } = { center: [12.5, 42.5], zoom: 5 };
/** How MapLibre's error starts when its worker file cannot load (maplibre-gl 6). */
const WORKER_FAILED = "Worker failed to load";

function markerElement(point: MapPoint): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = markerHtml(point);
  return holder.firstElementChild as HTMLElement;
}

/** Keeps the map's own controls out of the tab order: the frame around it is aria-hidden. */
function removeFromTabOrder(container: HTMLElement): void {
  for (const element of container.querySelectorAll("canvas, summary, a[href]")) {
    element.setAttribute("tabindex", "-1");
  }
}

export default function DayMapInner({ points }: { points: readonly MapPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [failed, setFailed] = useState(false);
  const scheme = useColorScheme();
  const key = pointsKey(points);
  // What the map shows now, so the effects below only touch what changed.
  const shown = useRef({ scheme, key });
  // The first render's stops and scheme, read once when the map is created.
  const initial = useRef({ points, scheme });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // MapLibre 6 needs WebGL 2; without it the frame says so instead of staying blank.
    if (typeof WebGL2RenderingContext === "undefined") {
      setFailed(true);
      return;
    }
    const origin = window.location.origin;
    setUpMap(origin);
    const { points: first, scheme: firstScheme } = initial.current;
    const bounds = lngLatBounds(first);
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: mapStyle(firstScheme, origin, routeData(first)),
        ...(bounds
          ? { bounds, fitBoundsOptions: { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM } }
          : ITALY),
        maxBounds: MAX_BOUNDS,
        minZoom: 5,
        maxZoom: 18,
        renderWorldCopies: false,
        // Decision: cooperative gestures, so a wheel or one finger on the map scrolls the page
        // past it; zooming takes Ctrl (or Cmd) and the wheel, or two fingers.
        cooperativeGestures: true,
        keyboard: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: false,
        locale: { "AttributionControl.ToggleAttribution": "Show map credits" },
      });
    } catch {
      // No WebGL 2 context (a GPU blocklist, a lost context): the notice, not a blank frame.
      setFailed(true);
      return;
    }
    map.touchZoomRotate.disableRotation();
    // Decision: tile and glyph errors are swallowed. A missing tile leaves a blank patch of
    // land and a missing glyph a missing label; the stops and route still draw. MapLibre
    // would otherwise log each one as a console error. Any other error is logged as before.
    // Decision: a worker that cannot load shows the notice, like a map chunk that cannot load.
    // Without the worker there is no basemap and no route, only numbered discs on blank paper.
    // It happens offline as long as scripts/write-precache.ts leaves the worker's files out.
    map.on("error", (event) => {
      if ("sourceId" in event) return;
      // String(): an error from a rejected promise need not be an Error with a message.
      if (String(event.error?.message).startsWith(WORKER_FAILED)) {
        setFailed(true);
        return;
      }
      console.error(event.error);
    });
    // Decision: round the basemap's tile zoom instead of flooring it. A day in a city is
    // framed near zoom 13.5, and the zoom 13 tiles leave out most short streets, so the old
    // centre of Florence came out nearly blank; this loads the zoom 14 tiles from 13.5.
    map.on("styledata", () => {
      const basemap = map.getSource(BASEMAP_SOURCE);
      if (basemap) basemap.roundZoom = true;
    });
    map.addControl(new AttributionControl({ compact: true, customAttribution: CREDITS }));
    // Start with the credits folded to their small button; the caption has them in full.
    container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    removeFromTabOrder(container);
    mapRef.current = map;
    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // The basemap's palette and the route, when the colour scheme or the stops change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (shown.current.scheme === scheme && shown.current.key === key)) return;
    map.setStyle(mapStyle(scheme, window.location.origin, routeData(points)));
  }, [scheme, key, points]);

  // One numbered marker per stop.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = points.map((point) =>
      new Marker({ element: markerElement(point) }).setLngLat([point.lng, point.lat]).addTo(map),
    );
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [points]);

  // The camera: a glide to the new stops, or a jump when the traveler prefers reduced motion.
  useEffect(() => {
    const map = mapRef.current;
    const bounds = lngLatBounds(points);
    if (!map || !bounds || shown.current.key === key) return;
    const motion = prefersReducedMotion()
      ? { animate: false }
      : { duration: CAMERA_MS, easing: easeOutExpo };
    map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, ...motion });
  }, [key, points]);

  useEffect(() => {
    shown.current = { scheme, key };
  }, [scheme, key]);

  if (failed) return <MapUnavailable />;
  return (
    <div
      ref={containerRef}
      className="map-canvas"
      style={markerColors(PALETTES[scheme]) as CSSProperties}
    />
  );
}
