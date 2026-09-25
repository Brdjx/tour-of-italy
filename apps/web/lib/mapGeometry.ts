import type { LatLng } from "./mapPoints";

// Screen geometry for the day map, kept out of the component so it is tested without a browser:
// where a stop lands on screen for a camera, whether a stop would sit under a control, which side
// of its stop a popup goes, and the keyframes that grow the map to full screen and back.

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  center: { lng: number; lat: number };
  zoom: number;
}

/** MapLibre's tiles are 512 px: the whole world is 512 px across at zoom 0. */
const TILE = 512;

/** Web Mercator, as a share of the world's width and height (0 to 1). */
function mercator(lng: number, lat: number): { x: number; y: number } {
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

/**
 * Where a place lands on a map of `size` px with this camera, in px from its top left. The map
 * never rotates or tilts (DayMapInner turns both off), so this is plain Web Mercator.
 */
export function screenPoint(point: LatLng, camera: Camera, size: Size): Point {
  const scale = TILE * 2 ** camera.zoom;
  const at = mercator(point.lng, point.lat);
  const center = mercator(camera.center.lng, camera.center.lat);
  return {
    x: size.width / 2 + (at.x - center.x) * scale,
    y: size.height / 2 + (at.y - center.y) * scale,
  };
}

/**
 * Whether any stop's disc, `reach` px around its place, would overlap `zone` on a map of
 * `size` px with this camera. A map with no size (not laid out yet) overlaps nothing.
 */
export function reachesZone(
  points: readonly LatLng[],
  camera: Camera,
  size: Size,
  zone: Box,
  reach: number,
): boolean {
  if (size.width <= 0 || size.height <= 0) return false;
  return points.some((point) => {
    const { x, y } = screenPoint(point, camera, size);
    return (
      x + reach > zone.left &&
      x - reach < zone.left + zone.width &&
      y + reach > zone.top &&
      y - reach < zone.top + zone.height
    );
  });
}

// ----- The stop's popup -----

export interface PopupRoom {
  width: number; // the map, in px
  height: number;
  // px along each edge that a popup must stay out of: the landscape notch at the sides, the day
  // switcher at the foot of the full-screen map.
  top: number;
  right: number;
  bottom: number;
  left: number;
  avoid?: readonly Box[]; // controls on the map a popup must stay off (the Expand pill)
}

/** What a popup should not hide: the other stops' centres, and the route's points in order. */
export interface PopupCrowd {
  stops: readonly Point[];
  route: readonly Point[];
}

export type PopupSide = "above" | "below" | "right" | "left";

export interface PopupPlacement {
  side: PopupSide;
  // px it slides along its side of the stop, to stay on the map: left (negative) or right of
  // centred above or below the stop, up (negative) or down from centred beside it.
  shift: number;
}

/** From a stop's centre to the popup: the disc's 14 px radius and 8 px of air. */
export const POPUP_GAP = 22;
/** The popup never comes closer than this to the map's edges or to a control on it. */
export const POPUP_EDGE = 8;
/** Another stop is covered when the popup comes this close to its centre: 14 px and 4 of air. */
const DISC_CLEAR = 14 + 4;
/**
 * The popup's number disc, from its left and top edges: 10 px of padding and the 11 px radius
 * (map.css). A popup lined up at one end puts its number level with the stop's.
 */
const NUMBER_AT = 21;
/** The sides a popup tries, in the order it prefers them when they hide the same. */
const SIDES: readonly PopupSide[] = ["above", "below", "right", "left"];
/** Along each side: centred on the stop, then lined up with its number at either end. */
const ALIGNS = ["centre", "start", "end"] as const;
const NO_CROWD: PopupCrowd = { stops: [], route: [] };

/**
 * Where a stop's popup goes. Each side of the stop is tried (above, below, right and left), and
 * along each side three places: centred on the stop, or lined up with its number level with the
 * stop's at either end, each slid just enough to stay on the map. The place that keeps it on the
 * map wins; among those, the one that covers the fewest other stops, then the fewest stretches of
 * route, then the first in that order. When nothing fits, the place that leaves the least of it
 * off the map wins, as the roomier side did before.
 * Decision: fewest hidden stops before fewest stretches of route. A covered stop is a number the
 * traveler cannot find; a covered stretch still shows on either side of the popup.
 * It never covers its own stop: it only moves along the stop's side, POPUP_GAP from its centre.
 */
export function placePopup(
  stop: Point,
  popup: Size,
  room: PopupRoom,
  crowd: PopupCrowd = NO_CROWD,
): PopupPlacement {
  let best: { placement: PopupPlacement; cost: number[] } | null = null;
  for (const side of SIDES) {
    for (const align of ALIGNS) {
      const { box, shift } = sideBox(side, align, stop, popup, room);
      const cost = [
        offMap(box, room),
        crowd.stops.filter((other) => nearBox(box, other, DISC_CLEAR)).length,
        segments(crowd.route).filter(([a, b]) => crosses(box, a, b)).length,
      ];
      if (!best || lower(cost, best.cost)) best = { placement: { side, shift }, cost };
    }
  }
  return (best as { placement: PopupPlacement }).placement;
}

/** The popup's box on `side` of the stop, placed along it by `align`, and slid to stay on the map. */
function sideBox(
  side: PopupSide,
  align: (typeof ALIGNS)[number],
  stop: Point,
  popup: Size,
  room: PopupRoom,
): { box: Box; shift: number } {
  const inner = innerBox(room);
  // Along the side: where the popup starts for each alignment, from the stop's centre.
  const along = (centre: number, length: number) => {
    if (align === "start") return centre - NUMBER_AT;
    if (align === "end") return centre + NUMBER_AT - length;
    return centre - length / 2;
  };
  if (side === "above" || side === "below") {
    const centred = stop.x - popup.width / 2;
    const want = along(stop.x, popup.width);
    const left = slide(want, inner.left, inner.left + inner.width - popup.width);
    const top = side === "above" ? stop.y - POPUP_GAP - popup.height : stop.y + POPUP_GAP;
    return { box: { left, top, ...popup }, shift: Math.round(left - centred) };
  }
  const centred = stop.y - popup.height / 2;
  const want = along(stop.y, popup.height);
  const top = slide(want, inner.top, inner.top + inner.height - popup.height);
  const left = side === "right" ? stop.x + POPUP_GAP : stop.x - POPUP_GAP - popup.width;
  return { box: { left, top, ...popup }, shift: Math.round(top - centred) };
}

/** The part of the map a popup may use: inside the room's edges by POPUP_EDGE. */
function innerBox(room: PopupRoom): Box {
  const left = room.left + POPUP_EDGE;
  const top = room.top + POPUP_EDGE;
  return {
    left,
    top,
    width: room.width - room.right - POPUP_EDGE - left,
    height: room.height - room.bottom - POPUP_EDGE - top,
  };
}

/** Slides `value` between `min` and `max`; a popup bigger than the room keeps to `min`. */
function slide(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/** How far, in px, the box is off the map or on a control: 0 when it is clear. */
function offMap(box: Box, room: PopupRoom): number {
  const inner = innerBox(room);
  const out =
    Math.max(0, inner.left - box.left) +
    Math.max(0, box.left + box.width - (inner.left + inner.width)) +
    Math.max(0, inner.top - box.top) +
    Math.max(0, box.top + box.height - (inner.top + inner.height));
  // On a control: the shortest move that would clear it, with POPUP_EDGE of air.
  const on = (room.avoid ?? []).reduce((sum, zone) => {
    const across =
      Math.min(box.left + box.width, zone.left + zone.width + POPUP_EDGE) -
      Math.max(box.left, zone.left - POPUP_EDGE);
    const down =
      Math.min(box.top + box.height, zone.top + zone.height + POPUP_EDGE) -
      Math.max(box.top, zone.top - POPUP_EDGE);
    return across > 0 && down > 0 ? sum + Math.min(across, down) : sum;
  }, 0);
  return out + on;
}

/** Whether a point comes within `reach` px of the box. */
function nearBox(box: Box, point: Point, reach: number): boolean {
  const x = Math.min(Math.max(point.x, box.left), box.left + box.width);
  const y = Math.min(Math.max(point.y, box.top), box.top + box.height);
  return (point.x - x) ** 2 + (point.y - y) ** 2 < reach ** 2;
}

function segments(route: readonly Point[]): [Point, Point][] {
  return route.slice(1).map((point, index) => [route[index] as Point, point]);
}

/** Whether any part of the straight segment from a to b lies inside the box (Liang-Barsky). */
function crosses(box: Box, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - box.left],
    [dx, box.left + box.width - a.x],
    [-dy, a.y - box.top],
    [dy, box.top + box.height - a.y],
  ];
  let enter = 0;
  let leave = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false; // parallel to this edge and outside it
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  return true;
}

/** Compares costs in order: the first that differs decides. */
function lower(cost: number[], than: number[]): boolean {
  for (const [index, value] of cost.entries()) {
    const other = than[index] as number;
    if (value !== other) return value < other;
  }
  return false;
}

// ----- Growing the map to full screen -----

export interface FlipFrames {
  frame: string[]; // the clipping frame: from the page's box to its own
  inner: string[]; // the map inside it, held at its real size and centred in the frame
}

/**
 * Keyframes for growing the full-screen map out of its box on the page, one per step of
 * progress from 0 (the page's box) to 1 (full screen), with transform-origin 0 0 on both.
 * Decision: the frame scales, and the map inside is scaled back by the inverse at every step, so
 * the map is never stretched: the frame's growing window shows more of it, centred where the
 * page's map was. Scale and its inverse do not interpolate linearly, so the steps are fine
 * enough (24) that the error between them is under a pixel.
 */
export function flipFrames(first: Box, last: Box, steps = 24): FlipFrames {
  const frame: string[] = [];
  const inner: string[] = [];
  const width = Math.max(1, last.width);
  const height = Math.max(1, last.height);
  const sx0 = Math.max(0.01, first.width / width);
  const sy0 = Math.max(0.01, first.height / height);
  for (let step = 0; step <= steps; step++) {
    const p = step / steps;
    const dx = (first.left - last.left) * (1 - p);
    const dy = (first.top - last.top) * (1 - p);
    const sx = sx0 + (1 - sx0) * p;
    const sy = sy0 + (1 - sy0) * p;
    frame.push(`translate(${fixed(dx)}px, ${fixed(dy)}px) scale(${fixed(sx)}, ${fixed(sy)})`);
    // The frame's window is (sx * width) wide; the map, at full width, is centred in it.
    const cx = ((sx - 1) * width) / 2;
    const cy = ((sy - 1) * height) / 2;
    inner.push(
      `scale(${fixed(1 / sx)}, ${fixed(1 / sy)}) translate(${fixed(cx)}px, ${fixed(cy)}px)`,
    );
  }
  return { frame, inner };
}

function fixed(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded === 0 ? 0 : rounded); // never -0
}
