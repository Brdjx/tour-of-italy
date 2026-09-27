import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TRAVEL, WATER_BUS_AREAS } from "../src/config";
import {
  formatDuration,
  haversineKm,
  SAME_SPOT_LABEL,
  type TravelMode,
  travelLabel,
  travelLabelBetween,
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

  it("never labels a leg with other minutes or mode words than its own", () => {
    const lagoon = WATER_BUS_AREAS[0]?.box;
    const inLagoon = (p: { lat: number; lng: number }) =>
      lagoon !== undefined &&
      p.lat >= lagoon.minLat &&
      p.lat <= lagoon.maxLat &&
      p.lng >= lagoon.minLng &&
      p.lng <= lagoon.maxLng;
    fc.assert(
      fc.property(italyPoint, italyPoint, (a, b) => {
        const leg = travelLeg(a, b);
        const byBoat = leg.mode === "local" && inLagoon(a) && inLagoon(b);
        const expected = byBoat
          ? `${formatDuration(leg.minutes)} by vaporetto`
          : travelLabelFor(leg.minutes, leg.mode);
        expect(leg.label).toBe(expected);
        expect(travelLabel(a, b)).toBe(leg.label);
        expect(travelLabelBetween(leg.minutes, a, b)).toBe(leg.label);
      }),
      FC_SETTINGS,
    );
  });
});

describe("Venice: the water bus and the islands", () => {
  const venice = realPlace("place_067"); // Doge's Palace, San Marco
  const basilica = realPlace("place_074"); // St. Mark's Basilica, next door
  const sanGiorgio = realPlace("place_088"); // San Giorgio Maggiore, its own island
  const burano = realPlace("place_070");

  it("never labels a leg inside the lagoon by taxi or bus", () => {
    expect(travelLeg(venice, burano).label).toBe(
      `${formatDuration(travelMinutes(venice, burano))} by vaporetto`,
    );
    expect(travelLeg(venice, burano).label).not.toMatch(/taxi/);
  });

  it("never calls the crossing to San Giorgio Maggiore a walk, in either direction", () => {
    const there = travelLeg(venice, sanGiorgio);
    expect(there.mode).toBe("local");
    expect(there.label).toMatch(/by vaporetto$/);
    expect(there.minutes).toBeGreaterThanOrEqual(TRAVEL.localOverheadMin);
    expect(travelMinutes(sanGiorgio, venice)).toBe(there.minutes);
    expect(travelMode(sanGiorgio, venice)).toBe("local");
  });

  it("keeps a walk a walk between neighbors on the same island", () => {
    expect(travelLeg(venice, basilica).mode).toBe("walk");
    expect(travelLeg(venice, basilica).label).toMatch(/walk$/);
  });

  it("never changes a leg outside the lagoon: Rome still goes by taxi or bus", () => {
    const leg = travelLeg(realPlace("place_001"), realPlace("place_002")); // Colosseum, Trastevere
    expect(leg.label).toMatch(/by taxi or bus$/);
  });

  // The page labels the minutes the scheduler gave a stop, which need not be the model's own.
  describe("travelLabelBetween, for a planned stop's minutes", () => {
    const colosseum = realPlace("place_001");
    const trastevere = realPlace("place_002");

    it("says by vaporetto for a local leg inside the lagoon", () => {
      expect(travelLabelBetween(20, venice, burano)).toBe("20 min by vaporetto");
      expect(travelLabelBetween(15, sanGiorgio, venice)).toBe("15 min by vaporetto");
    });

    it("says by taxi or bus for a local leg on the mainland", () => {
      expect(travelLabelBetween(15, colosseum, trastevere)).toBe("15 min by taxi or bus");
    });

    it("keeps a walk and the longer modes as travelLabelFor words them", () => {
      expect(travelLabelBetween(5, venice, basilica)).toBe("5 min walk");
      expect(travelLabelBetween(200, colosseum, venice)).toBe(travelLabelFor(200, "intercity"));
    });

    it("says the same spot for 0 minutes, in the lagoon or out of it", () => {
      expect(travelLabelBetween(0, venice, burano)).toBe(SAME_SPOT_LABEL);
      expect(travelLabelBetween(0, colosseum, trastevere)).toBe(SAME_SPOT_LABEL);
    });
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
