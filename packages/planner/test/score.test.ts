import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MIN_SUGGEST_RATING, OUTING_DISTANCE_CAP_KM, SCORE_WEIGHTS } from "../src/config";
import { placesOfAnchor } from "../src/context";
import { DEFAULT_RATING, interestShare, rankPlaces, scoreParts, scorePlace } from "../src/score";
import { addDays } from "../src/time";
import { FC_SETTINGS, makePlace, realContext, realPlace } from "./plannerFixtures";

// Scoring picks which valid place comes next. It must be deterministic (the same request gives
// the same plan in the browser and the Lambda), never NaN (NaN sorts unpredictably), and a
// must-include must always win. Each weight is pinned so a config change shows up here.

const TUESDAY = "2026-10-20";
const none = { interests: [], mustInclude: [] };

describe("score terms", () => {
  it("never drifts from the formula: interest share, rating, and local favorite for Da Enzo", () => {
    const parts = scoreParts(realPlace("place_003"), {
      interests: ["food", "wine"],
      mustInclude: [],
    });
    expect(parts.interest).toBeCloseTo(SCORE_WEIGHTS.interestMatch * 0.5, 9);
    expect(parts.rating).toBeCloseTo(SCORE_WEIGHTS.rating * (4.6 / 5), 9);
    expect(parts.iconic).toBe(0);
    expect(parts.localFavorite).toBe(SCORE_WEIGHTS.localFavorite);
    expect(parts.total).toBeCloseTo(1.5 + 1.38 + 0.25, 6);
  });

  it("never buries a headline sight under a local favorite when no interests are chosen", () => {
    // The review found 13 Roman local favorites (a book market among them) above the Colosseum
    // and the Vatican Museums, which then never made a Rome trip.
    const colosseum = scorePlace(realPlace("place_001"), none);
    const vatican = scorePlace(realPlace("place_010"), none);
    const bookMarket = scorePlace(realPlace("place_024"), none);
    const trastevere = scorePlace(realPlace("place_002"), none);
    expect(scoreParts(realPlace("place_001"), none).iconic).toBe(SCORE_WEIGHTS.iconic);
    for (const favorite of [bookMarket, trastevere]) {
      expect(colosseum).toBeGreaterThan(favorite);
      expect(vatican).toBeGreaterThan(favorite);
    }
  });

  it("counts each interest once, so repeating an interest cannot inflate the match", () => {
    const place = makePlace({ tags: ["food"] });
    expect(interestShare(place, ["food", "food", "wine"])).toBe(0.5);
  });

  it("scores zero interest match, not NaN, when the traveler picks no interests", () => {
    expect(interestShare(makePlace(), [])).toBe(0);
    expect(Number.isFinite(scorePlace(makePlace(), none))).toBe(true);
  });

  it("never rewards or sinks a missing rating: it counts as the 3.5 suggestion threshold", () => {
    expect(DEFAULT_RATING).toBe(MIN_SUGGEST_RATING);
    expect(scoreParts(makePlace({ rating: null }), none).rating).toBeCloseTo(
      SCORE_WEIGHTS.rating * (DEFAULT_RATING / 5),
      9,
    );
  });

  it("penalizes unknown hours (Appian Way) but not open-access or estimated windows", () => {
    const penalty = -SCORE_WEIGHTS.hoursUnknownPenalty;
    expect(scoreParts(realPlace("place_021"), none, { date: TUESDAY }).hoursUnknown).toBe(penalty);
    expect(scoreParts(realPlace("place_021"), none).hoursUnknown).toBe(penalty);
    expect(scoreParts(realPlace("place_008"), none, { date: TUESDAY }).hoursUnknown).toBe(0);
    expect(scoreParts(realPlace("place_077"), none, { date: TUESDAY }).hoursUnknown).toBe(0);
  });

  it("charges distance from where the traveler is, per km", () => {
    const pantheon = realPlace("place_005");
    const parts = scoreParts(realPlace("place_001"), none, { from: pantheon });
    expect(parts.distance).toBeCloseTo(-SCORE_WEIGHTS.distancePenaltyPerKm * 1.5736, 3);
    expect(Object.is(scoreParts(realPlace("place_001"), none, { from: null }).distance, 0)).toBe(
      true,
    );
  });

  it("never charges a day trip for every km of the trip out, but still charges a sight in town", () => {
    // Review finding: charged per km from Florence, Pienza (-4.2) and Siena (-2.5) lost to any
    // city sight even for a traveler whose interests they match, so no day trip was ever planned.
    const florence = realContext().anchorById.get("florence")?.centroid ?? null;
    const cap = -SCORE_WEIGHTS.distancePenaltyPerKm * OUTING_DISTANCE_CAP_KM;
    expect(scoreParts(realPlace("place_089"), none, { from: florence }).distance).toBeCloseTo(
      cap,
      6,
    );
    expect(scoreParts(realPlace("place_038"), none, { from: florence }).distance).toBeCloseTo(
      cap,
      6,
    );
    // An ordinary stop out of town (a 90-minute tasting in Modena) still pays for every km.
    const bologna = realContext().anchorById.get("bologna")?.centroid ?? null;
    const acetaia = scoreParts(realPlace("place_083"), none, { from: bologna }).distance;
    expect(acetaia).toBeLessThan(cap * 3);
    // An outing close by (the Vatican Museums from the Pantheon) pays its real distance.
    const vatican = scoreParts(realPlace("place_010"), none, { from: realPlace("place_005") });
    expect(vatican.distance).toBeGreaterThan(cap);
    expect(vatican.distance).toBeLessThan(0);
  });

  it("penalizes a second museum in a row but not a museum after a restaurant", () => {
    const museum = realPlace("place_007");
    expect(scoreParts(museum, none, { previousType: "museum" }).repeatType).toBe(
      -SCORE_WEIGHTS.repeatTypePenalty,
    );
    expect(scoreParts(museum, none, { previousType: "restaurant" }).repeatType).toBe(0);
  });

  it("adds the must-include bonus only to the place the traveler named", () => {
    const request = { interests: [], mustInclude: ["place_007"] };
    expect(scoreParts(realPlace("place_007"), request).mustInclude).toBe(SCORE_WEIGHTS.mustInclude);
    expect(scoreParts(realPlace("place_010"), request).mustInclude).toBe(0);
  });

  it("throws on an impossible date instead of scoring against the wrong weekday", () => {
    expect(() => scorePlace(realPlace("place_001"), none, { date: "2026-13-01" })).toThrow(
      RangeError,
    );
  });
});

describe("ranking", () => {
  it("breaks exact ties by id, so the same request always gives the same order", () => {
    const b = makePlace({ id: "place_b" });
    const a = makePlace({ id: "place_a" });
    expect(rankPlaces([b, a], none).map((s) => s.place.id)).toEqual(["place_a", "place_b"]);
  });

  it("treats scores a float hair apart as a tie and falls back to id order", () => {
    const from = { lat: 41.9, lng: 12.5 };
    const b = makePlace({ id: "place_b", lat: 41.89, lng: 12.49 });
    const a = makePlace({ id: "place_a", lat: 41.89 - 1e-9, lng: 12.49 }); // a hair farther: loses without rounding
    const rawA = scoreParts(a, none, { from }).distance;
    const rawB = scoreParts(b, none, { from }).distance;
    expect(rawA).not.toBe(rawB); // the raw terms really differ
    const ranked = rankPlaces([b, a], none, { from });
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
    expect(ranked.map((s) => s.place.id)).toEqual(["place_a", "place_b"]);
  });

  it("gives the same ranking for any input order of a base's places", () => {
    const rome = placesOfAnchor(realContext(), "rome");
    const request = { interests: ["food", "art"], mustInclude: [] };
    const situation = {
      date: TUESDAY,
      from: realPlace("place_001"),
      previousType: "historic_site" as const,
    };
    const expected = rankPlaces(rome, request, situation).map((s) => s.place.id);
    fc.assert(
      fc.property(fc.shuffledSubarray(rome, { minLength: rome.length }), (shuffled) => {
        expect(rankPlaces(shuffled, request, situation).map((s) => s.place.id)).toEqual(expected);
      }),
      { ...FC_SETTINGS, numRuns: 100 },
    );
  });

  it("always ranks a must-include place first in its base, whatever else is going on", () => {
    const ctx = realContext();
    const tags = [...new Set(ctx.places.flatMap((p) => p.tags))];
    fc.assert(
      fc.property(
        fc.nat({ max: ctx.anchors.length - 1 }),
        fc.nat({ max: 1000 }),
        fc.subarray(tags, { maxLength: 8 }),
        fc.integer({ min: 0, max: 1100 }),
        (anchorIndex, pick, interests, dayOffset) => {
          const anchor = ctx.anchors[anchorIndex];
          if (!anchor) return;
          const places = placesOfAnchor(ctx, anchor.id);
          const must = places[pick % places.length];
          if (!must) return;
          const situation = {
            date: addDays("2026-01-01", dayOffset),
            from: anchor.centroid,
            previousType: must.type,
          };
          const ranked = rankPlaces(places, { interests, mustInclude: [must.id] }, situation);
          expect(ranked[0]?.place.id).toBe(must.id);
        },
      ),
      FC_SETTINGS,
    );
  });

  it("never produces a NaN or infinite score for any real place, date, or position", () => {
    const places = realContext().places;
    fc.assert(
      fc.property(
        fc.nat({ max: places.length - 1 }),
        fc.nat({ max: places.length - 1 }),
        fc.integer({ min: 0, max: 1100 }),
        (i, j, dayOffset) => {
          const place = places[i];
          const from = places[j];
          if (!place || !from) return;
          const score = scorePlace(
            place,
            { interests: from.tags, mustInclude: [] },
            {
              date: addDays("2026-01-01", dayOffset),
              from,
              previousType: from.type,
            },
          );
          expect(Number.isFinite(score)).toBe(true);
        },
      ),
      FC_SETTINGS,
    );
  });
});
