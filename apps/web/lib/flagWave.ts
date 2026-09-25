// The flag mark's geometry (components/FlagMark.tsx): the Italian flag, three vertical bands in
// its official 2:3 proportion, and one breath of wind through it. The hoist (the left edge) is
// held still; a ripple travels from it to the fly (the right edge), growing as it goes, while
// the fly draws in, and the flag comes back to rest flat. A fold of light and shade travels with
// the ripple, worked out from the cloth's own slope: lit where it turns up toward the light at the
// top left (where the page's sweep starts), shaded where it falls away. Each frame of a shape is a
// path with the same commands in the same order, so SMIL can interpolate between them in every
// browser (CSS cannot animate `d` in Safari).

/** The flag's box: 30 by 20, the 2:3 of the flag. */
export const FLAG_WIDTH = 30;
export const FLAG_HEIGHT = 20;

/** Where the fabric is at one moment: the lift at the hoist, the two band seams and the fly. */
export interface WaveFrame {
  lift: readonly [number, number, number, number]; // vertical offset at each of the 4 edges
  fly: number; // x of the fly edge
}

const REST: WaveFrame = { lift: [0, 0, 0, 0], fly: FLAG_WIDTH };

// Decision: the ripple lifts the cloth by up to 2.4 of its 20 (about 4 px at the desktop title)
// and draws the fly in by 1 of 30. At the old 0.8 and 0.4 the breath moved the edge by about a
// pixel and did not register at the mark's size; at 4 or more the flag flaps instead of waves.
const PEAK_LIFT = 2.4;
const PULL_IN = 1;
/** The ripple's length, in flag widths: a little more than the flag, so one crest shows at once. */
const WAVELENGTH = 1.3;
/** How far the ripple travels over the breath, in wavelengths: one crest, hoist to fly. */
const TRAVEL = 1;
/** Cloth near the hoist is held by it: the ripple grows toward the fly by this power of x. */
const REACH = 0.6;
/** The breath peaks early and settles slowly, like a gust: time is bent by this power. */
const GUST = 0.75;
/** Frames across the breath, evenly spaced: enough that straight steps between them read as one
 * smooth motion (about 130 ms apart). */
const STEPS = 12;

/** The wind's strength at `t` (0 to 1): nothing at either end, arriving and leaving smoothly. */
function breath(t: number): number {
  return Math.sin(Math.PI * t ** GUST) ** 2;
}

function frameAt(t: number): WaveFrame {
  const strength = breath(t);
  const at = (index: number) => {
    const x = index / 3;
    const phase = 2 * Math.PI * (x / WAVELENGTH - TRAVEL * t);
    return -PEAK_LIFT * strength * x ** REACH * Math.sin(phase);
  };
  return { lift: [0, at(1), at(2), at(3)], fly: FLAG_WIDTH - PULL_IN * strength };
}

/** One breath of wind: rest, the ripple from the hoist to the fly, rest. */
export const WAVE_FRAMES: readonly WaveFrame[] = [
  REST,
  ...Array.from({ length: STEPS - 1 }, (_, index) => frameAt((index + 1) / STEPS)),
  REST,
];

/** When each frame is reached, as a share of the wave's length (SMIL keyTimes). */
export const WAVE_KEY_TIMES: readonly number[] = WAVE_FRAMES.map((_, index) => index / STEPS);

/** The whole wave, in ms. */
export const WAVE_MS = 1600;

interface Point {
  x: number;
  y: number;
}

/** A number for a path: at most two decimals, no trailing zeros, never "-0". */
function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function pt(point: Point): string {
  return `${num(point.x)} ${num(point.y)}`;
}

/** The four points along the top edge (the hoist, the two seams, the fly), `dy` lower. */
function edgePoints(frame: WaveFrame, dy: number): Point[] {
  return frame.lift.map((lift, index) => ({ x: (frame.fly * index) / 3, y: lift + dy }));
}

/**
 * The control points of the smooth curve (Catmull-Rom, as cubic Béziers) from point `from` to
 * point `from + 1`: the tangent at each point runs parallel to the line between its neighbours,
 * so the edge bends without a kink at the seams. The points are evenly spaced across, so each
 * curve's x runs evenly with its parameter and its slope is its y's rate over a third of the fly.
 */
function controls(points: readonly Point[], from: number): [Point, Point] {
  const at = (index: number) => points[Math.max(0, Math.min(points.length - 1, index))] as Point;
  const tangent = (index: number) => {
    const before = at(index - 1);
    const after = at(index + 1);
    const span = index === 0 || index === points.length - 1 ? 1 : 2;
    return { x: (after.x - before.x) / span, y: (after.y - before.y) / span };
  };
  const start = at(from);
  const end = at(from + 1);
  const t0 = tangent(from);
  const t1 = tangent(from + 1);
  return [
    { x: start.x + t0.x / 3, y: start.y + t0.y / 3 },
    { x: end.x - t1.x / 3, y: end.y - t1.y / 3 },
  ];
}

/** Band 0 (green), 1 (white) or 2 (red) at one moment: its top edge, fly side, bottom edge. */
export function bandPath(band: 0 | 1 | 2, frame: WaveFrame): string {
  const top = edgePoints(frame, 0);
  const bottom = edgePoints(frame, FLAG_HEIGHT);
  const [a, b] = controls(top, band);
  const [c, d] = controls(bottom, band);
  const start = top[band] as Point;
  const end = top[band + 1] as Point;
  const endLow = bottom[band + 1] as Point;
  const startLow = bottom[band] as Point;
  return `M${pt(start)}C${pt(a)} ${pt(b)} ${pt(end)}L${pt(endLow)}C${pt(d)} ${pt(c)} ${pt(startLow)}Z`;
}

/** The whole cloth at one moment, hoist to fly, for the light and shade laid over the bands. */
export function clothPath(frame: WaveFrame): string {
  const top = edgePoints(frame, 0);
  const bottom = edgePoints(frame, FLAG_HEIGHT);
  const across = [0, 1, 2].map((from) => {
    const [a, b] = controls(top, from);
    return `C${pt(a)} ${pt(b)} ${pt(top[from + 1] as Point)}`;
  });
  const back = [2, 1, 0].map((from) => {
    const [c, d] = controls(bottom, from);
    return `C${pt(d)} ${pt(c)} ${pt(bottom[from] as Point)}`;
  });
  return `M${pt(top[0] as Point)}${across.join("")}L${pt(bottom[3] as Point)}${back.join("")}Z`;
}

/** The white band's top or bottom edge alone, for the hairline that holds it on white paper. */
export function edgePath(edge: "top" | "bottom", frame: WaveFrame): string {
  const points = edgePoints(frame, edge === "top" ? 0 : FLAG_HEIGHT);
  const [a, b] = controls(points, 1);
  return `M${pt(points[1] as Point)}C${pt(a)} ${pt(b)} ${pt(points[2] as Point)}`;
}

/** SMIL `values` for one shape through the whole wave. */
export function waveValues(shape: (frame: WaveFrame) => string): string {
  return WAVE_FRAMES.map(shape).join(";");
}

/** The shape at rest, the flat flag: what shows before, after and without the wave. */
export function restShape(shape: (frame: WaveFrame) => string): string {
  return shape(REST);
}

// ----- Light and shade -----

/** Where the gradient samples the cloth, as shares of its width: every quarter of a band. */
export const SHADE_OFFSETS: readonly number[] = Array.from({ length: 13 }, (_, k) => k / 12);

/** The strongest light (paper) and shade (ink) laid over the colours, as opacities. */
export const LIGHT_MAX = 0.2;
export const SHADE_MAX = 0.2;
/** The cloth's slope at which the light or shade is at its strongest. */
const FULL_SLOPE = 0.25;

/** The top edge's slope (down is positive) at `share` of the cloth's width, at one moment. */
export function slopeAt(frame: WaveFrame, share: number): number {
  const top = edgePoints(frame, 0);
  const from = Math.min(2, Math.floor(share * 3));
  const t = share * 3 - from;
  const [a, b] = controls(top, from);
  const p0 = (top[from] as Point).y;
  const p3 = (top[from + 1] as Point).y;
  // The Bézier's rate of y over its parameter, over x's even rate (a third of the fly).
  const dy = 3 * ((1 - t) ** 2 * (a.y - p0) + 2 * (1 - t) * t * (b.y - a.y) + t ** 2 * (p3 - b.y));
  return dy / (frame.fly / 3);
}

/** The light or the shade at one sample across the cloth, at one moment: 0 on a flat flag. */
export function shadeAt(kind: "light" | "shade", frame: WaveFrame, share: number): number {
  const slope = slopeAt(frame, share);
  // Rising to the right (a negative slope, the SVG's y runs down) faces the top left.
  const toward = kind === "light" ? -slope : slope;
  const strength = Math.min(1, Math.max(0, toward / FULL_SLOPE));
  return Math.round(strength * (kind === "light" ? LIGHT_MAX : SHADE_MAX) * 1000) / 1000;
}

/** SMIL `values` for one gradient stop's opacity through the whole wave. */
export function shadeValues(kind: "light" | "shade", share: number): string {
  return WAVE_FRAMES.map((frame) => String(shadeAt(kind, frame, share))).join(";");
}
