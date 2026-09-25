"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  AttributionControl,
  type LngLatBoundsLike,
  type LngLatLike,
  Map as MapLibreMap,
  Marker,
  type PaddingOptions,
} from "maplibre-gl";
import {
  type FocusEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type Box,
  type PopupPlacement,
  type PopupRoom,
  placePopup,
  reachesZone,
} from "../lib/mapGeometry";
import { lngLatBounds, type MapPoint, routeData } from "../lib/mapPoints";
import { BASEMAP_SOURCE, mapStyle, markerColors, PALETTES } from "../lib/mapStyle";
import type { StopRef } from "../lib/useStopDetails";
import { ExpandIcon } from "./icons";
import {
  CAMERA_MS,
  DISC_REACH,
  EXPAND_CLEAR,
  easeOutExpo,
  expandZone,
  FADE_IN_MS,
  FADE_OUT_MS,
  FIT_MAX_ZOOM,
  FIT_PADDING,
  GROW_MS,
  pointsKey,
  prefersReducedMotion,
  SHRINK_MS,
} from "./map/camera";
import { MapDialog } from "./map/MapDialog";
import { MapStop, type MapStopHandlers } from "./map/MapStop";
import { MapUnavailable } from "./map/MapUnavailable";
import { fade, flip, settled } from "./map/motion";
import { setUpMap } from "./map/setup";
import { spreadOffsets } from "./map/spread";
import type { DayMapInnerProps } from "./map/types";
import { useColorScheme } from "./map/useColorScheme";
import { closeModal, showModal } from "./Sheet";

// The MapLibre map itself, loaded only in the browser (see DayMap): the self-hosted vector
// basemap (lib/mapStyle.ts), the route as straight ink segments in visiting order, and one
// numbered stop per place (map/MapStop.tsx). When the day or its stops change the camera glides
// to the new stops. The drawing is hidden from screen readers (the timetable is its text
// equivalent); the stops are buttons that open the stop's details sheet, and the credits it
// shows are repeated as links under it.
//
// "Expand map" shows the same map full screen (map/MapDialog.tsx) and "Close map" brings it back.
// Decision: one MapLibre map, moved between the page and the dialog, not a second map for full
// screen. MapLibre draws into a container it owns; that container is created here, outside
// React, so it can move between the page's frame and the dialog without React noticing. A second
// map would cost a second WebGL context, a second parse of the style and every tile again, and
// the traveler would watch it load; the moved map keeps its tiles, its camera and its markers,
// and only resizes (the measurements are in DESIGN.md).

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
/** A hovered stop shows its popup after this long, like a tooltip, and keeps it this long after. */
const HOVER_DELAY = 250;
const LEAVE_DELAY = 150;
/** The page's side gutter (--gutter-x-left and --gutter-x-right in globals.css, at their least). */
const GUTTER = 16;

type Screen = "page" | "full" | "leaving";
type Padding = Required<PaddingOptions>;

/** Keeps the map's own controls out of the tab order and its drawing away from screen readers. */
function quiet(container: HTMLElement): void {
  for (const element of container.querySelectorAll("canvas, summary, a[href]")) {
    element.setAttribute("tabindex", "-1");
  }
  for (const element of container.querySelectorAll(
    ".maplibregl-canvas, .maplibregl-control-container",
  )) {
    element.setAttribute("aria-hidden", "true");
  }
}

function boxOf(element: Element): Box {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

/** Whether focus on this element came from the keyboard (the browser's own judgement). */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true; // a browser that cannot tell: show it, as for the keyboard
  }
}

/**
 * The page's padding for these stops: even on every side, or deeper at the top when a stop would
 * sit under the Expand pill in the top right corner. `region` is the page map's box within the
 * map's container (the whole container on the page; a centred box while full screen closes).
 * Decision: the room is added only when a stop would reach the pill, so most days keep the
 * even frame and a day with a stop in that corner is framed lower instead of hiding it.
 */
function pagePadding(
  map: MapLibreMap,
  bounds: LngLatBoundsLike,
  points: readonly MapPoint[],
  canvas: { width: number; height: number },
  region: Box,
): Padding {
  const even = {
    top: region.top + FIT_PADDING,
    right: canvas.width - region.left - region.width + FIT_PADDING,
    bottom: canvas.height - region.top - region.height + FIT_PADDING,
    left: region.left + FIT_PADDING,
  };
  const camera = map.cameraForBounds(bounds, { padding: even, maxZoom: FIT_MAX_ZOOM });
  if (!camera?.center || camera.zoom === undefined) return even;
  const center = lngLatOf(camera.center);
  return reachesZone(points, { center, zoom: camera.zoom }, canvas, expandZone(region), DISC_REACH)
    ? { ...even, top: region.top + EXPAND_CLEAR }
    : even;
}

function lngLatOf(like: LngLatLike): { lng: number; lat: number } {
  if (Array.isArray(like)) return { lng: like[0], lat: like[1] };
  return "lng" in like ? { lng: like.lng, lat: like.lat } : { lng: like.lon, lat: like.lat };
}

/**
 * The room the day switcher takes at the foot of the full-screen map, in px from the bottom.
 * Decision: from layout, not from the screen, so it is right while the switcher is still
 * sliding in (it rises 8 px as the map finishes growing).
 */
function switcherRoom(stage: HTMLElement, switcher: HTMLElement): number {
  return stage.clientHeight - switcher.offsetTop;
}

function sizeOf(element: HTMLElement): { width: number; height: number } {
  return { width: element.clientWidth, height: element.clientHeight };
}

/**
 * The landscape notch on each side of the full-screen map, in px, read from its header: the
 * header's side padding is the gutter or the safe area, whichever is wider, so padding past the
 * gutter is the safe area.
 */
function notchOf(head: HTMLElement | null): { left: number; right: number } {
  const style = head ? getComputedStyle(head) : null;
  const safe = (value: string | undefined) => {
    const padding = Number.parseFloat(value ?? "") || 0;
    return padding > GUTTER ? padding : 0;
  };
  return { left: safe(style?.paddingLeft), right: safe(style?.paddingRight) };
}

/**
 * Whether this device has a pointer that can hover. A phone has none; its browser still sends a
 * mouse's pointerenter where the last tap was when the layout moves under it (after Close map,
 * say), which is no hover and must not show a popup.
 */
function canHover(): boolean {
  return window.matchMedia?.("(any-hover: hover)").matches ?? true;
}

export default function DayMapInner(props: DayMapInnerProps) {
  const { points, title, days, active, onSelectDay, onDetails } = props;
  const containerRef = useRef<HTMLDivElement | null>(null); // MapLibre's, created below
  const pageHost = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const fullHost = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLFieldSetElement>(null);
  const dialogId = useId();
  const mapRef = useRef<MapLibreMap | null>(null);
  const [failed, setFailed] = useState(false);
  const scheme = useColorScheme();
  const key = pointsKey(points);
  // What the map shows now, so the effects below only touch what changed.
  const shown = useRef({ scheme, key });
  // The first render's stops and scheme, read once when the map is created.
  const initial = useRef({ points, scheme });
  // Where the map is: on the page, full screen, or on its way back.
  const screen = useRef<Screen>("page");
  const running = useRef<Animation[]>([]);
  // The stops drawn now, with the elements MapLibre moves for them (each MapStop renders into
  // one). Kept together so a new day never pairs one day's stops with the other's elements.
  const [stops, setStops] = useState<{ points: readonly MapPoint[]; hosts: HTMLElement[] }>({
    points: [],
    hosts: [],
  });
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const popupRef = useRef<HTMLButtonElement>(null);
  const [popup, setPopup] = useState<{ index: number; placement: PopupPlacement | null } | null>(
    null,
  );
  const popupNow = useRef(popup);
  popupNow.current = popup;
  const hovered = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const pointer = useRef<string | null>(null); // the kind of pointer that pressed a stop last
  const latest = useRef(props);
  latest.current = props;
  const stopsNow = useRef(stops);
  stopsNow.current = stops;

  // The button of another stop on this map, where focus goes when the details sheet closes on a
  // stop the traveler stepped to (useStopDetails); null for a stop the map does not draw. By its
  // number first, then its place, as the day's order may have changed under the sheet.
  const findStop = useCallback((stop: StopRef) => {
    const points = stopsNow.current.points;
    const numbered = points.findIndex(
      (point) => point.number === stop.index + 1 && point.placeId === stop.placeId,
    );
    const index =
      numbered >= 0 ? numbered : points.findIndex((point) => point.placeId === stop.placeId);
    return index < 0 ? null : (buttons.current[index] ?? null);
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const showPopup = useCallback(
    (index: number) => {
      clearTimer();
      setPopup((current) => (current?.index === index ? current : { index, placement: null }));
    },
    [clearTimer],
  );

  const hidePopup = useCallback(() => {
    clearTimer();
    setPopup(null);
  }, [clearTimer]);

  useEffect(() => {
    const host = pageHost.current;
    if (!host) return;
    // MapLibre 6 needs WebGL 2; without it the frame says so instead of staying blank.
    if (typeof WebGL2RenderingContext === "undefined") {
      setFailed(true);
      return;
    }
    const origin = window.location.origin;
    setUpMap(origin);
    const container = document.createElement("div");
    container.className = "map-canvas";
    host.append(container);
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
        // Decision: cooperative gestures on the page, so a wheel or one finger on the map
        // scrolls the page past it; zooming takes Ctrl (or Cmd) and the wheel, or two fingers.
        // Full screen there is no page to scroll, so the map takes every gesture there.
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
      container.remove();
      setFailed(true);
      return;
    }
    containerRef.current = container;
    // The first frame keeps its stops clear of the Expand pill; no camera move, it has not drawn.
    if (bounds) {
      const padding = pagePadding(map, bounds, first, sizeOf(container), {
        left: 0,
        top: 0,
        ...sizeOf(container),
      });
      if (padding.top !== FIT_PADDING) {
        map.fitBounds(bounds, { padding, maxZoom: FIT_MAX_ZOOM, animate: false });
      }
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
    // A drag or a zoom by the traveler puts away a stop's popup; the camera's own glides do not.
    map.on("movestart", (event) => {
      if ("originalEvent" in event && event.originalEvent) hidePopup();
    });
    map.addControl(new AttributionControl({ compact: true, customAttribution: CREDITS }));
    // Start with the credits folded to their small button; the caption has them in full.
    container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    quiet(container);
    mapRef.current = map;
    return () => {
      for (const animation of running.current) animation.cancel();
      mapRef.current = null;
      containerRef.current = null;
      map.remove();
      container.remove();
    };
  }, [hidePopup]);

  // The stops' ink and paper follow the map's palette.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    for (const [name, value] of Object.entries(markerColors(PALETTES[scheme]))) {
      container.style.setProperty(name, value);
    }
  }, [scheme]);

  // The basemap's palette and the route, when the colour scheme or the stops change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (shown.current.scheme === scheme && shown.current.key === key)) return;
    map.setStyle(mapStyle(scheme, window.location.origin, routeData(points)));
  }, [scheme, key, points]);

  // One stop per place, nudged apart where they would overlap (map/spread.ts). A new day or new
  // stops put away any popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const hosts = points.map((_, index) => {
      const element = document.createElement("div");
      // Decision: earlier stops draw above later ones. MapLibre stacks markers in the order
      // they are added, so where stops crowd together the last stop of the day covered the
      // first, the one the traveler looks for first.
      element.style.zIndex = String(points.length - index);
      return element;
    });
    const markers = points.map((point, index) =>
      new Marker({ element: hosts[index] as HTMLElement })
        .setLngLat([point.lng, point.lat])
        .addTo(map),
    );
    setStops({ points, hosts });
    hidePopup();
    // Decision: the nudge is worked out again on every zoom frame, not only when a zoom ends.
    // How far apart two stops are on screen depends only on the zoom (the map never rotates or
    // tilts), and the push fades to nothing as they separate, so during the camera's glide the
    // discs ease apart or back onto their places with it instead of jumping at the end.
    const spread = () => {
      const offsets = spreadOffsets(points.map((point) => map.project([point.lng, point.lat])));
      markers.forEach((marker, index) => {
        marker.setOffset(offsets[index] ?? [0, 0]);
      });
    };
    spread();
    map.on("zoom", spread);
    return () => {
      map.off("zoom", spread);
      for (const marker of markers) marker.remove();
    };
  }, [points, hidePopup]);

  // The camera: a glide to the new stops, or a jump when the traveler prefers reduced motion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: padding reads the map's current screen.
  useEffect(() => {
    const map = mapRef.current;
    const bounds = lngLatBounds(points);
    if (!map || !bounds || shown.current.key === key) return;
    const motion = prefersReducedMotion()
      ? { animate: false }
      : { duration: CAMERA_MS, easing: easeOutExpo };
    map.fitBounds(bounds, { padding: padding(map, bounds), maxZoom: FIT_MAX_ZOOM, ...motion });
  }, [key, points]);

  useEffect(() => {
    shown.current = { scheme, key };
  }, [scheme, key]);

  /** Padding for the map where it is now: the page's, or full screen's. */
  function padding(map: MapLibreMap, bounds: LngLatBoundsLike): Padding {
    const container = containerRef.current as HTMLDivElement;
    if (screen.current !== "page") return fullPadding();
    const size = sizeOf(container);
    return pagePadding(map, bounds, latest.current.points, size, { left: 0, top: 0, ...size });
  }

  /** The room the day switcher takes at the foot of the full-screen map, or 0 without one. */
  function footRoom(): number {
    const stage = stageRef.current;
    const switcher = switcherRef.current;
    return stage && switcher ? switcherRoom(stage, switcher) : 0;
  }

  /**
   * Full screen: even padding plus the notch in landscape, and room at the foot for the day
   * switcher, so no stop sits under either.
   */
  function fullPadding(): Padding {
    const notch = notchOf(headRef.current);
    const foot = footRoom();
    return {
      top: FIT_PADDING,
      right: FIT_PADDING + notch.right,
      bottom: Math.max(FIT_PADDING, foot > 0 ? foot + DISC_REACH : 0),
      left: FIT_PADDING + notch.left,
    };
  }

  /**
   * Where a popup may go on a map of `size`: clear of the Expand pill on the page; clear of the
   * notch and the day switcher full screen (the header sits above the map, not on it).
   */
  function popupRoom(size: { width: number; height: number }): PopupRoom {
    if (screen.current === "page") {
      const zone = expandZone({ left: 0, top: 0, ...size });
      return { ...size, top: 0, right: 0, bottom: 0, left: 0, avoid: [zone] };
    }
    const notch = notchOf(headRef.current);
    return { ...size, top: 0, right: notch.right, bottom: footRoom(), left: notch.left };
  }

  // ----- A stop's popup -----

  const openDetails = (index: number) => {
    const point = stops.points[index];
    const button = buttons.current[index];
    if (!point || !button) return;
    hidePopup();
    onDetails({ index: point.number - 1, placeId: point.placeId }, button, findStop);
  };

  const handlers: MapStopHandlers = {
    onPointerEnter: (index, event: PointerEvent) => {
      if (event.pointerType === "touch" || !canHover()) return;
      hovered.current = index;
      clearTimer();
      // Moving from one stop's popup to the next shows the next at once, as tooltips do.
      if (popupNow.current) showPopup(index);
      else timer.current = window.setTimeout(() => showPopup(index), HOVER_DELAY);
    },
    onPointerLeave: (index, event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovered.current = null;
      clearTimer();
      const focused = stops.hosts[index]?.contains(document.activeElement);
      if (popupNow.current?.index === index && !focused) {
        timer.current = window.setTimeout(hidePopup, LEAVE_DELAY);
      }
    },
    onPointerDown: (event: PointerEvent) => {
      pointer.current = event.pointerType;
    },
    onFocus: (index, event: FocusEvent<HTMLButtonElement>) => {
      if (focusVisible(event.currentTarget)) showPopup(index);
    },
    onBlur: (index, event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && stops.hosts[index]?.contains(next)) return;
      if (hovered.current === index) return;
      if (popupNow.current?.index === index) hidePopup();
    },
    // Decision: a mouse click or Enter opens the details at once (hovering already showed the
    // popup); a tap shows the popup first, since a finger cannot hover, and a second tap on the
    // stop or its popup opens the details.
    onPress: (index) => {
      const kind = pointer.current;
      pointer.current = null;
      if ((kind === "touch" || kind === "pen") && popupNow.current?.index !== index) {
        showPopup(index);
        return;
      }
      openDetails(index);
    },
    onDetails: openDetails,
  };

  // Place the popup once it has a size: on the side of its stop that stays on the map and hides
  // the fewest other stops and stretches of route (lib/mapGeometry.ts).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the room reads the map's current screen.
  useLayoutEffect(() => {
    if (!popup || popup.placement) return;
    const element = popupRef.current;
    const host = stops.hosts[popup.index];
    const container = containerRef.current;
    const map = mapRef.current;
    if (!element || !host || !container || !map) return;
    const area = container.getBoundingClientRect();
    const centre = (other: Element) => {
      const at = other.getBoundingClientRect();
      return { x: at.left + at.width / 2 - area.left, y: at.top + at.height / 2 - area.top };
    };
    const placement = placePopup(
      centre(host),
      { width: element.offsetWidth, height: element.offsetHeight },
      popupRoom({ width: area.width, height: area.height }),
      {
        stops: stops.hosts.filter((other) => other !== host).map(centre),
        // The route joins the places themselves, not the nudged discs.
        route: stops.points.map((point) => map.project([point.lng, point.lat])),
      },
    );
    setPopup({ index: popup.index, placement });
  }, [popup, stops]);

  // The stop with a popup draws above every other stop, so its popup is never under a disc.
  useLayoutEffect(() => {
    const host = popup ? stops.hosts[popup.index] : undefined;
    if (!host) return;
    const before = host.style.zIndex;
    host.style.zIndex = String(stops.hosts.length + 1);
    return () => {
      host.style.zIndex = before;
    };
  }, [popup, stops.hosts]);

  // While a popup shows: Escape puts it away, and so does a press anywhere but its stop.
  // Decision: Escape on the page's map, or anywhere while the map is full screen, is the popup's
  // alone, so it does not also close the full-screen map behind it. Escape from anywhere else on
  // the page (a note the traveler opened on the board while the mouse rests on a stop) puts the
  // popup away and still reaches what it was pressed for.
  const popupIndex = popup?.index ?? null;
  useEffect(() => {
    if (popupIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      hidePopup();
      const target = event.target instanceof Node ? event.target : null;
      if (!dialogRef.current?.open && !containerRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onPress = (event: globalThis.PointerEvent) => {
      const host = stops.hosts[popupIndex];
      if (host && event.target instanceof Node && host.contains(event.target)) return;
      hidePopup();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [popupIndex, stops.hosts, hidePopup]);

  useEffect(() => clearTimer, [clearTimer]);

  // ----- Full screen -----

  const openFull = () => {
    const map = mapRef.current;
    const container = containerRef.current;
    const dialog = dialogRef;
    const frame = frameRef;
    const inner = innerRef;
    const host = fullHost;
    const page = pageHost.current;
    if (screen.current !== "page" || !map || !container || !page) return;
    if (!dialog.current || !frame.current || !inner.current || !host.current) return;
    hidePopup();
    const from = boxOf(page);
    screen.current = "full";
    dialog.current.dataset.state = "enter";
    showModal(dialog.current);
    // The same map, now in the dialog: it keeps its centre and zoom, so the middle of the full
    // screen shows exactly what the page showed, and the frame's growing window reveals more.
    host.current.append(container);
    map.resize();
    map.cooperativeGestures.disable();
    headingRef.current?.focus({ preventScroll: true });
    const reduced = prefersReducedMotion();
    running.current = reduced
      ? fade(dialog.current, true, FADE_IN_MS)
      : flip(frame.current, inner.current, from, boxOf(frame.current), "grow", GROW_MS);
    // The header and the day switcher follow the growing map in (map.css).
    const target = dialog.current;
    requestAnimationFrame(() => {
      if (screen.current === "full") target.dataset.state = "full";
    });
    const bounds = lngLatBounds(latest.current.points);
    if (bounds) {
      const motion = reduced ? { animate: false } : { duration: CAMERA_MS, easing: easeOutExpo };
      map.fitBounds(bounds, { padding: fullPadding(), maxZoom: FIT_MAX_ZOOM, ...motion });
    }
    void settled(running.current).then(() => {
      // Tiles fill the final size, whatever the viewport did meanwhile (a toolbar that hid).
      if (screen.current === "full") mapRef.current?.resize();
    });
  };

  // Everything back on the page, at once: the end of closing, or a dialog the browser closed.
  const restore = () => {
    const map = mapRef.current;
    const container = containerRef.current;
    const page = pageHost.current;
    const dialog = dialogRef.current;
    if (map && container && page) {
      page.append(container);
      map.resize();
      map.cooperativeGestures.enable();
    }
    if (dialog) {
      if (dialog.open) closeModal(dialog);
      delete dialog.dataset.state;
    }
    for (const animation of running.current) animation.cancel();
    running.current = [];
    screen.current = "page";
    expandRef.current?.focus({ preventScroll: true });
  };

  const closeFull = () => {
    const map = mapRef.current;
    const container = containerRef.current;
    const dialog = dialogRef;
    const frame = frameRef;
    const inner = innerRef;
    const page = pageHost.current;
    if (screen.current !== "full") return;
    if (!map || !container || !page || !dialog.current || !frame.current || !inner.current) {
      restore();
      return;
    }
    // A close while the map is still growing starts from where it has grown to.
    for (const animation of running.current) animation.finish();
    hidePopup();
    screen.current = "leaving";
    dialog.current.dataset.state = "leaving";
    const to = boxOf(page);
    const bounds = lngLatBounds(latest.current.points);
    const reduced = prefersReducedMotion();
    if (bounds) {
      // The camera settles on the page's framing as the window shrinks onto the page, so the map
      // lands exactly where the page's map will carry on.
      const canvas = sizeOf(container);
      const region = {
        left: (canvas.width - to.width) / 2,
        top: (canvas.height - to.height) / 2,
        width: to.width,
        height: to.height,
      };
      const framing = pagePadding(map, bounds, latest.current.points, canvas, region);
      const motion = reduced ? { animate: false } : { duration: SHRINK_MS, easing: easeOutExpo };
      map.fitBounds(bounds, { padding: framing, maxZoom: FIT_MAX_ZOOM, ...motion });
    }
    running.current = reduced
      ? fade(dialog.current, false, FADE_OUT_MS)
      : flip(frame.current, inner.current, boxOf(frame.current), to, "shrink", SHRINK_MS);
    void settled(running.current).then(() => {
      if (screen.current === "leaving") restore();
    });
  };

  const onDialogClosed = () => {
    if (screen.current !== "page") restore();
  };

  if (failed) return <MapUnavailable />;
  return (
    <>
      <button
        ref={expandRef}
        type="button"
        className="pill pill--line pill--round map-expand"
        onClick={openFull}
        aria-label="Expand map"
        aria-haspopup="dialog"
        aria-controls={dialogId}
        data-testid="map-expand"
      >
        <ExpandIcon size={20} />
      </button>
      <div ref={pageHost} className="map-host" data-testid="map-host" />
      {stops.hosts.map((host, index) => {
        const point = stops.points[index];
        if (!point) return null;
        const open = popup?.index === index;
        return createPortal(
          <MapStop
            point={point}
            index={index}
            popup={open}
            placement={open ? (popup?.placement ?? null) : null}
            buttonRef={(element) => {
              buttons.current[index] = element;
            }}
            popupRef={popupRef}
            handlers={handlers}
          />,
          host,
          `${point.placeId}-${index}`,
        );
      })}
      {createPortal(
        <MapDialog
          id={dialogId}
          title={title}
          count={points.length}
          days={days}
          active={active}
          onSelectDay={onSelectDay}
          onRequestClose={closeFull}
          onClosed={onDialogClosed}
          refs={{
            dialog: dialogRef,
            head: headRef,
            heading: headingRef,
            stage: stageRef,
            frame: frameRef,
            inner: innerRef,
            host: fullHost,
            days: switcherRef,
          }}
        />,
        document.body,
      )}
    </>
  );
}
