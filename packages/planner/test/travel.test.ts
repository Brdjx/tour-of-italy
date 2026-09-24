import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TRAVEL } from "../src/config";
import {
  formatDuration,
  haversineKm,
  SAME_SPOT_LABEL,
  type TravelMode,
  travelLabel,
  travelLabelFor,
  travelLeg,
  travelMinutes,
  travelMinutesForKm,
  travelMode,
  travelModeForKm,
} from "../src/travel";
import { FC_SETTINGS, italyPoint, realPlace } from "./plannerFixtures";

// Failure vector F1 (impossible travel): if the travel model underestimates a leg, the scheduler
// and the validator both accept a day the traveler cannot actually do. These tests pin the four
// bands, their edges, the rounding, and the guarantees the validator relies on.

/** The band formula re-derived from config, independently of travel.ts. */
function rawMinutes(km: number, mode: TravelMode): number {
  const bands = {
    walk: [0, TRAVEL.walkKmh],
    local: [TRAVEL.localOverheadMin, TRAVEL.localKmh],
    regional: [TRAVEL.regionalOverheadMin, TRAVEL.regionalKmh],
    intercity: [TRAVEL.intercityOverheadMin, TRAVEL.intercityKmh],
  } as const;
  const [overhead, kmh] = bands[mode];
  return overhead + (km / kmh) * 60;
}

describe("travel on real places", () => {
  it("measures Colosseum to Pantheon as a short city hop, never a train ride", () => {
    const leg = travelLeg(realPlace("place_001"), realPlace("place_005"));
    expect(leg.km).toBeGreaterThan(1.3);
    expect(leg.km).toBeLessThan(2.2);
    expect(leg).toMatchObject({ mode: "local", minutes: 15, label: "15 min by taxi or bus" });
  });

  it("measures Rome to Florence as about 230 km on high-speed rail, not a 3-hour drive", () => {
    const leg = travelLeg(realPlace("place_001"), realPlace("place_026"));
    expect(leg.km).toBeGreaterThan(225);
    expect(leg.km).toBeLessThan(235);
    expect(leg).toMatchObject({
      mode: "intercity",
      minutes: 130,
      label: "2 h 10 min by high-speed train",
    });
  });

  it("gives two places on one spot zero minutes and says so, instead of a 0 min walk", () => {
    const trevi = realPlace("place_018");
    const treviByNight = realPlace("place_077");
    expect(travelMinutes(trevi, treviByNight)).toBe(0);
    expect(travelLabel(trevi, treviByNight)).toBe(SAME_SPOT_LABEL);
    expect(travelMode(trevi, treviByNight)).toBe("walk");
  });
});

describe("travel bands", () => {
  // Rows: distance, band, minutes. Each edge belongs to the lower band.
  it.each<[number, TravelMode, number]>([
    [0, "walk", 0],
    [1.5, "walk", 20],
    [1.5 + 1e-9, "local", 15],
    [20, "local", 60],
    [20 + 1e-9, "regional", 50],
    [150, "regional", 160],
    [150 + 1e-9, "intercity", 100],
  ])(
    "puts %s km in the %s band at %s min, so a band edge never flips a leg's mode",
    (km, mode, minutes) => {
      expect(travelModeForKm(km)).toBe(mode);
      expect(travelMinutesForKm(km)).toBe(minutes);
    },
  );

  it.each<[number, number]>([
    [0.1, 5], // 1.3 min walk
    [0.375, 5], // exactly 5.0 min walk: stays 5
    [0.75, 10], // exactly 10 min walk
    [0.7500001, 15], // just over 10 min: rounds up
    [12.5, 40], // 10 + 30 min local, exact
    [70, 90], // 30 + 60 min regional, exact
    [170, 105], // 45 + 60 min intercity, exact
  ])("rounds %s km up to %s min, never down and never a step too far", (km, minutes) => {
    expect(travelMinutesForKm(km)).toBe(minutes);
  });

  it("never returns negative zero for a vanishing distance, so equality checks hold", () => {
    expect(Object.is(travelMinutesForKm(1e-12), 0)).toBe(true);
    expect(Object.is(travelMinutesForKm(0), 0)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.5])(
    "throws on a %s km distance instead of letting NaN slip past every time comparison",
    (km) => {
      expect(() => travelModeForKm(km)).toThrow(RangeError);
      expect(() => travelMinutesForKm(km)).toThrow(RangeError);
    },
  );

  it("throws on a non-finite coordinate instead of returning NaN minutes", () => {
    const rome = { lat: 41.9, lng: 12.5 };
    expect(() => travelMinutes(rome, { lat: Number.NaN, lng: 12.5 })).toThrow(RangeError);
    expect(() => travelLeg({ lat: 41.9, lng: Number.POSITIVE_INFINITY }, rome)).toThrow(RangeError);
  });
});

describe("travel properties", () => {
  it("is symmetric, so the scheduler and the validator agree whichever way they measure", () => {
    fc.assert(
      fc.property(italyPoint, italyPoint, (a, b) => {
        expect(travelLeg(a, b)).toEqual(travelLeg(b, a));
      }),
      FC_SETTINGS,
    );
  });

  it("never underestimates a leg: minutes are the band time rounded up to the next 5", () => {
    fc.assert(
      fc.property(italyPoint, italyPoint, (a, b) => {
        const leg = travelLeg(a, b);
        const raw = rawMinutes(leg.km, leg.mode);
        expect(leg.km).toBeCloseTo(haversineKm(a, b), 9);
        expect(leg.minutes % TRAVEL.roundToMin).toBe(0);
        expect(leg.minutes).toBeGreaterThanOrEqual(raw - 1e-6);
        expect(leg.minutes).toBeLessThan(raw + TRAVEL.roundToMin);
      }),
      FC_SETTINGS,
    );
  });

  it("labels every leg with its own minutes and mode words", () => {
    fc.assert(
      fc.property(italyPoint, italyPoint, (a, b) => {
        const leg = travelLeg(a, b);
        expect(leg.label).toBe(travelLabelFor(leg.minutes, leg.mode));
        expect(travelLabel(a, b)).toBe(leg.label);
      }),
      FC_SETTINGS,
    );
  });
});

describe("travel labels", () => {
  it.each<[number, TravelMode, string]>([
    [12, "walk", "12 min walk"],
    [25, "local", "25 min by taxi or bus"],
    [100, "regional", "1 h 40 min by train or car"],
    [130, "intercity", "2 h 10 min by high-speed train"],
    [120, "intercity", "2 h by high-speed train"],
    [0, "walk", SAME_SPOT_LABEL],
  ])("labels %s min by %s as %j", (minutes, mode, label) => {
    expect(travelLabelFor(minutes, mode)).toBe(label);
  });

  it.each<[number, string]>([
    [0, "0 min"],
    [5, "5 min"],
    [59, "59 min"],
    [60, "1 h"],
    [61, "1 h 1 min"],
    [185, "3 h 5 min"],
  ])("formats %s minutes as %j, never as a decimal hour", (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });

  it.each([-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses to format %s minutes rather than showing garbage",
    (minutes) => {
      expect(() => formatDuration(minutes)).toThrow(RangeError);
    },
  );
});
