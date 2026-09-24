import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REASON_MAX_CHARS } from "../src/config";
import { ruleReason } from "../src/reasons";
import type { StopRole } from "../src/types";
import { FC_SETTINGS, makePlace, realContext, realPlace } from "./plannerFixtures";

// Rule reasons are shown on every deterministic stop and replace any AI reason the API drops
// (failure vector F3). They must be true to the data, never name another place, never exceed the
// length limit, and never contain the clock times, durations, or prices the AI sanitizer rejects,
// or a dropped AI reason would be replaced by one that is dropped too.

const none = { interests: [], mustInclude: [] };
const ROLES: StopRole[] = ["visit", "lunch", "dinner"];
const EM_DASH = String.fromCharCode(0x2014);
const SANITIZER_REJECTS = /\d{1,2}[:.]\d{2}|\d\s*(am|pm|h|min|€|euro)\b|€/i;

describe("ruleReason wording", () => {
  it.each([
    [
      "place_003",
      { interests: ["food", "wine"], mustInclude: [] },
      "Matches your interest in food. Rated 4.6 out of 5. A local favorite.",
    ],
    [
      "place_010",
      { interests: [], mustInclude: ["place_010"] },
      "You asked to include this. Museum in Borgo. Rated 4.7 out of 5.",
    ],
    ["place_026", none, "Museum in Piazza della Signoria. Rated 4.8 out of 5."],
    ["place_002", none, "Neighborhood in Rome. Rated 4.7 out of 5. A local favorite."],
  ])("explains visit %s from its own data only", (id, request, text) => {
    expect(ruleReason(realPlace(id), request, "visit")).toBe(text);
  });

  it("says a dinner is close to the previous stop only when that stop is a walk away", () => {
    const enzo = realPlace("place_003");
    const request = { interests: ["food"], mustInclude: [] };
    expect(ruleReason(enzo, request, "dinner", realPlace("place_002"))).toBe(
      "Dinner at a restaurant in Trastevere, close to your previous stop. Matches your interest in food. Rated 4.6 out of 5.",
    );
    expect(ruleReason(enzo, request, "lunch", realPlace("place_026"))).toBe(
      "Lunch at a restaurant in Trastevere. Matches your interest in food. Rated 4.6 out of 5.",
    );
    expect(ruleReason(enzo, request, "lunch", null)).not.toContain("close to");
  });

  it("names the venue for markets and says 'Dinner in' for a food walk, never 'at an experience'", () => {
    const market = { interests: ["market", "food", "budget", "morning"], mustInclude: [] };
    expect(ruleReason(realPlace("place_015"), market, "lunch")).toBe(
      "Lunch at a market in Testaccio. Matches your interest in market, food and budget. Rated 4.7 out of 5.",
    );
    expect(ruleReason(realPlace("place_068"), none, "dinner", realPlace("place_075"))).toBe(
      "Dinner in Cannaregio, close to your previous stop. Rated 4.8 out of 5.",
    );
  });

  it("never says 'Dinner at a shop' for Eataly, whose type is shop: the meal reads 'Dinner in Ostiense'", () => {
    const eataly = realPlace("place_099");
    expect(eataly.type).toBe("shop");
    expect(ruleReason(eataly, none, "dinner")).toMatch(/^Dinner in Ostiense\./);
    expect(ruleReason(eataly, none, "lunch")).not.toContain("at a shop");
  });

  it.each([
    [4.75, "Rated 4.8 out of 5."],
    [5, "Rated 5 out of 5."],
    [0, "Rated 0 out of 5."],
  ])("rounds a rating of %s to one decimal: %j", (rating, sentence) => {
    expect(ruleReason(makePlace({ rating }), none, "visit")).toContain(sentence);
  });

  it("leaves out the rating sentence when the place has no rating, instead of 'Rated null'", () => {
    const text = ruleReason(makePlace({ rating: null }), none, "visit");
    expect(text).toBe("Museum in Celio.");
  });

  it("makes no closeness claim when the previous position is not a real coordinate", () => {
    const text = ruleReason(realPlace("place_003"), none, "dinner", { lat: Number.NaN, lng: 12 });
    expect(text).toBe("Dinner at a restaurant in Trastevere. Rated 4.6 out of 5.");
  });

  it("names at most three matched interests so the sentence stays readable", () => {
    const place = makePlace({ tags: ["art", "food", "wine", "views"] });
    const text = ruleReason(
      place,
      { interests: ["art", "food", "wine", "views"], mustInclude: [] },
      "visit",
    );
    expect(text).toContain("Matches your interest in art, food and wine.");
  });
});

describe("ruleReason guarantees over the real data", () => {
  const places = realContext().places;
  const allTags = [...new Set(places.flatMap((p) => p.tags))];
  const otherNames = (id: string) =>
    places
      .filter((p) => p.id !== id)
      .flatMap((p) => [p.name, p.name.split(",")[0] ?? p.name])
      .map((name) => name.trim().toLowerCase());

  it("never names another place, whatever the role, interests, or previous stop", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: places.length - 1 }),
        fc.nat({ max: places.length - 1 }),
        fc.constantFrom(...ROLES),
        fc.subarray(allTags, { maxLength: 8 }),
        fc.boolean(),
        (i, j, role, interests, must) => {
          const place = places[i];
          const prev = places[j];
          if (!place || !prev) return;
          const request = { interests, mustInclude: must ? [place.id] : [] };
          const text = ruleReason(place, request, role, prev).toLowerCase();
          for (const name of otherNames(place.id)) expect(text.includes(name)).toBe(false);
        },
      ),
      { ...FC_SETTINGS, numRuns: 200 },
    );
  });

  it("stays within the length limit and passes the AI reason sanitizer for every place and role", () => {
    for (const place of places) {
      for (const role of ROLES) {
        const request = { interests: place.tags, mustInclude: [place.id] };
        const text = ruleReason(place, request, role, place);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
        expect(text).not.toMatch(SANITIZER_REJECTS);
        expect(text).not.toContain(EM_DASH);
        expect(text.endsWith(".")).toBe(true);
      }
    }
  });
});

describe("ruleReason on hostile data", () => {
  const text = fc.string({ maxLength: 400, unit: "binary" });

  it("never exceeds the length limit, never comes back empty, and strips control characters", () => {
    fc.assert(
      fc.property(
        text,
        fc.option(text, { nil: null }),
        fc.array(text, { maxLength: 6 }),
        fc.option(fc.double({ min: 0, max: 5, noNaN: true }), { nil: null }),
        fc.constantFrom(...ROLES),
        (city, neighborhood, tags, rating, role) => {
          const place = makePlace({ city, neighborhood, tags, rating });
          const reason = ruleReason(
            place,
            { interests: tags, mustInclude: [place.id] },
            role,
            place,
          );
          expect(reason.length).toBeGreaterThan(0);
          expect(reason.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
          expect(reason).not.toMatch(/[\p{Cc}\p{Cf}]/u);
          expect(reason).toBe(reason.trim());
        },
      ),
      FC_SETTINGS,
    );
  });

  it("skips an over-long neighborhood sentence rather than cutting a word in half", () => {
    const place = makePlace({ neighborhood: "N".repeat(200), rating: 4 });
    expect(ruleReason(place, none, "visit")).toBe("Rated 4 out of 5.");
    expect(
      ruleReason(makePlace({ neighborhood: "N".repeat(200), rating: null }), none, "lunch"),
    ).toBe("Lunch stop.");
  });
});
