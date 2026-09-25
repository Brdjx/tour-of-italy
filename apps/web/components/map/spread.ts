// Keeps every stop number on the map readable when stops sit close together. The discs are
// 28 px across, so at the zoom that frames a whole day, stops a street apart land on top of each
// other and a later disc hid an earlier number. Two things fix it: an earlier stop is drawn above
// a later one (DayMapInner sets its z-index), and discs closer than MARKER_MIN_GAP are nudged
// apart along the line between them, never further than MARKER_MAX_NUDGE from their place.

/** A disc's centre on screen, in px. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Centre to centre, in px, at which the lower disc's number is clear of the disc above it: the
 * upper disc's 14 px radius plus half a two-digit number (about 7 px), and a pixel to spare.
 */
export const MARKER_MIN_GAP = 22;
/** The furthest a disc moves from its place, in px, so it still reads as that place. */
export const MARKER_MAX_NUDGE = 12;
/** Relaxation rounds: enough for a cluster of three or four, cheap enough for every zoom frame. */
const ROUNDS = 6;
/** Directions for discs on the exact same spot, fanned out by stop order (the golden angle). */
const GOLDEN_ANGLE = 2.399963;

/**
 * The offset, in px, for each disc, in the same order as `points`. Discs already MARKER_MIN_GAP
 * apart get [0, 0]. The push shrinks to nothing as a pair reaches the gap, so zooming in eases
 * the discs back onto their places instead of snapping them.
 */
export function spreadOffsets(
  points: readonly ScreenPoint[],
  gap = MARKER_MIN_GAP,
  maxNudge = MARKER_MAX_NUDGE,
): [number, number][] {
  const offsets = points.map((): [number, number] => [0, 0]);
  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (separate(points, offsets, i, j, gap, maxNudge)) moved = true;
      }
    }
    if (!moved) break;
  }
  // Half-pixel steps: finer than the eye can see, and no repaint for noise in the last digits.
  return offsets.map(([x, y]) => [roundHalf(x), roundHalf(y)]);
}

/** Pushes discs i and j apart by half the shortfall each. Returns whether either moved. */
function separate(
  points: readonly ScreenPoint[],
  offsets: [number, number][],
  i: number,
  j: number,
  gap: number,
  maxNudge: number,
): boolean {
  const a = points[i] as ScreenPoint;
  const b = points[j] as ScreenPoint;
  const oa = offsets[i] as [number, number];
  const ob = offsets[j] as [number, number];
  let dx = b.x + ob[0] - (a.x + oa[0]);
  let dy = b.y + ob[1] - (a.y + oa[1]);
  let distance = Math.hypot(dx, dy);
  if (distance >= gap) return false;
  if (distance < 0.01) {
    // Decision: two stops on the same spot (a place and its evening visit) have no line between
    // them, so the later one steps out at an angle set by its order; the result is the same on
    // every render and every zoom.
    dx = Math.cos(j * GOLDEN_ANGLE);
    dy = Math.sin(j * GOLDEN_ANGLE);
    distance = 0;
  } else {
    dx /= distance;
    dy /= distance;
  }
  const push = (gap - distance) / 2;
  const beforeA: [number, number] = [oa[0], oa[1]];
  const beforeB: [number, number] = [ob[0], ob[1]];
  offsets[i] = clamp([oa[0] - dx * push, oa[1] - dy * push], maxNudge);
  offsets[j] = clamp([ob[0] + dx * push, ob[1] + dy * push], maxNudge);
  return changed(beforeA, offsets[i]) || changed(beforeB, offsets[j]);
}

/** The offset, shortened to `max` px when it is longer. */
function clamp([x, y]: [number, number], max: number): [number, number] {
  const length = Math.hypot(x, y);
  if (length <= max) return [x, y];
  return [(x / length) * max, (y / length) * max];
}

function changed(before: [number, number], after: [number, number]): boolean {
  return Math.abs(before[0] - after[0]) > 0.01 || Math.abs(before[1] - after[1]) > 0.01;
}

function roundHalf(value: number): number {
  const rounded = Math.round(value * 2) / 2;
  return rounded === 0 ? 0 : rounded; // never -0
}
