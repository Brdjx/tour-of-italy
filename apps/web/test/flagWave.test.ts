import { describe, expect, it } from "vitest";
import {
  bandPath,
  clothPath,
  edgePath,
  FLAG_HEIGHT,
  FLAG_WIDTH,
  LIGHT_MAX,
  restShape,
  SHADE_MAX,
  SHADE_OFFSETS,
  shadeAt,
  shadeValues,
  slopeAt,
  WAVE_FRAMES,
  WAVE_KEY_TIMES,
  type WaveFrame,
  waveValues,
} from "../lib/flagWave";

// The flag mark's wave is SMIL path morphing, which only works when every frame of a shape has
// the same commands in the same order. The flag must rest flat in the 2:3 of the flag, its bands
// must meet without gaps, its hoist must stay put, and the wave must be big enough to see at the
// title's cap height without flapping. Its light and shade come from the cloth's slope, so they
// are nothing on the flat flag.

const bands = [0, 1, 2] as const;

/** The command letters of a path, in order: its structure, without its numbers. */
const commands = (path: string) => path.replace(/[^A-Za-z]/g, "");

/** Every number in a path. */
const numbers = (path: string) => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("the flag mark's geometry", () => {
  it("rests as three equal bands filling the 2:3 box", () => {
    expect(FLAG_WIDTH / FLAG_HEIGHT).toBe(1.5);
    expect(restShape((frame) => bandPath(0, frame))).toBe(
      "M0 0C3.33 0 6.67 0 10 0L10 20C6.67 20 3.33 20 0 20Z",
    );
    expect(restShape((frame) => bandPath(2, frame))).toBe(
      "M20 0C23.33 0 26.67 0 30 0L30 20C26.67 20 23.33 20 20 20Z",
    );
    expect(restShape((frame) => edgePath("top", frame))).toBe("M10 0C13.33 0 16.67 0 20 0");
    expect(restShape((frame) => edgePath("bottom", frame))).toBe("M10 20C13.33 20 16.67 20 20 20");
  });

  it("keeps every frame of a shape in the same commands, so SMIL can morph between them", () => {
    const shapes = [
      ...bands.map((band) => (frame: WaveFrame) => bandPath(band, frame)),
      (frame: WaveFrame) => edgePath("top", frame),
      (frame: WaveFrame) => edgePath("bottom", frame),
      clothPath,
    ];
    for (const shape of shapes) {
      const frames = waveValues(shape).split(";");
      expect(frames).toHaveLength(WAVE_FRAMES.length);
      const structure = commands(frames[0] as string);
      for (const frame of frames) {
        expect(commands(frame)).toBe(structure);
        expect(numbers(frame)).toHaveLength(numbers(frames[0] as string).length);
        expect(frame).not.toMatch(/(^|[ A-Z])-0( |$|[A-Z])/);
      }
    }
  });

  it("starts and ends the wave at rest, on an even timeline SMIL accepts", () => {
    expect(WAVE_FRAMES[0]).toEqual(WAVE_FRAMES.at(-1));
    expect(WAVE_FRAMES[0]).toEqual({ lift: [0, 0, 0, 0], fly: FLAG_WIDTH });
    expect(WAVE_KEY_TIMES).toHaveLength(WAVE_FRAMES.length);
    expect(WAVE_KEY_TIMES[0]).toBe(0);
    expect(WAVE_KEY_TIMES.at(-1)).toBe(1);
    const step = 1 / (WAVE_KEY_TIMES.length - 1);
    for (let index = 1; index < WAVE_KEY_TIMES.length; index++) {
      expect(WAVE_KEY_TIMES[index]).toBeCloseTo((WAVE_KEY_TIMES[index - 1] as number) + step, 9);
    }
  });

  it("holds the hoist still and waves enough to see, without flapping", () => {
    const lifts = WAVE_FRAMES.flatMap((frame) => frame.lift.map(Math.abs));
    const flies = WAVE_FRAMES.map((frame) => frame.fly);
    for (const frame of WAVE_FRAMES) {
      expect(frame.lift[0]).toBe(0);
      expect(bandPath(0, frame).startsWith("M0 0C")).toBe(true);
    }
    // At its peak the cloth lifts about a tenth of its height and the fly draws in by one unit:
    // about 4 px and 1.5 px at the desktop title, where 0.8 and 0.4 did not register.
    expect(Math.max(...lifts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lifts)).toBeLessThanOrEqual(2.5);
    expect(Math.min(...flies)).toBeCloseTo(FLAG_WIDTH - 1, 1);
    expect(Math.max(...flies)).toBe(FLAG_WIDTH);
  });

  it("carries the ripple from the hoist to the fly", () => {
    // Where the cloth lifts highest moves toward the fly as the breath goes on.
    const highest = WAVE_FRAMES.slice(1, -1).map((frame) => {
      const lifts = frame.lift.map((lift) => -lift);
      return lifts.indexOf(Math.max(...lifts));
    });
    expect(highest[0]).toBeLessThan(Math.max(...highest));
    expect(highest.indexOf(3)).toBeGreaterThan(highest.indexOf(2));
  });

  it("joins neighbouring bands at the same seam in every frame, so no gap opens", () => {
    for (const frame of WAVE_FRAMES) {
      for (const band of [0, 1] as const) {
        const left = numbers(bandPath(band, frame));
        const right = numbers(bandPath((band + 1) as 1 | 2, frame));
        // The left band's top-right corner is the right band's top-left corner.
        expect(left.slice(6, 8)).toEqual(right.slice(0, 2));
        // Its bottom-right corner is the right band's bottom-left corner.
        expect(left.slice(8, 10)).toEqual(right.slice(14, 16));
      }
    }
  });
});

describe("the flag mark's light and shade", () => {
  const [rest] = WAVE_FRAMES as [WaveFrame];

  it("is nothing on the flat flag, before and after the wave", () => {
    for (const share of SHADE_OFFSETS) {
      expect(slopeAt(rest, share)).toBe(0);
      for (const kind of ["light", "shade"] as const) {
        const values = shadeValues(kind, share).split(";");
        expect(values).toHaveLength(WAVE_FRAMES.length);
        expect(values[0]).toBe("0");
        expect(values.at(-1)).toBe("0");
      }
    }
  });

  it("samples every quarter of a band, hoist to fly", () => {
    expect(SHADE_OFFSETS).toHaveLength(13);
    expect(SHADE_OFFSETS[0]).toBe(0);
    expect(SHADE_OFFSETS.at(-1)).toBe(1);
  });

  it("lights the cloth where it rises toward the top left and shades it where it falls away", () => {
    let lit = 0;
    let shaded = 0;
    for (const frame of WAVE_FRAMES) {
      for (const share of SHADE_OFFSETS) {
        const slope = slopeAt(frame, share);
        const light = shadeAt("light", frame, share);
        const shade = shadeAt("shade", frame, share);
        // Never both at once, and never past their soft limits.
        expect(light === 0 || shade === 0).toBe(true);
        expect(light).toBeLessThanOrEqual(LIGHT_MAX);
        expect(shade).toBeLessThanOrEqual(SHADE_MAX);
        if (light > 0) expect(slope).toBeLessThan(0);
        if (shade > 0) expect(slope).toBeGreaterThan(0);
        lit = Math.max(lit, light);
        shaded = Math.max(shaded, shade);
      }
    }
    // Both come near their full strength at the height of the breath, so the fold reads.
    expect(lit).toBeGreaterThanOrEqual(0.8 * LIGHT_MAX);
    expect(shaded).toBeGreaterThanOrEqual(0.8 * SHADE_MAX);
  });

  it("reads the slope off the drawn edge", () => {
    // A straight rise across the whole flag: every sample has the same slope, rise over run.
    const ramp: WaveFrame = { lift: [0, -1, -2, -3], fly: FLAG_WIDTH };
    for (const share of SHADE_OFFSETS) expect(slopeAt(ramp, share)).toBeCloseTo(-0.1, 9);
  });
});
