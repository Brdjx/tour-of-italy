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
      "Matches your interest in food. Listed as a local favorite. Rated 4.6 out of 5.",
    ],
    [
      "place_010",
      { interests: [], mustInclude: ["place_010"] },
      "You asked to include this. Listed as iconic. Rated 4.7 out of 5.",
    ],
    ["place_026", none, "Listed as iconic. Rated 4.8 out of 5."],
    ["place_002", none, "Listed as a local favorite. Rated 4.7 out of 5."],
    ["place_011", none, "Listed as iconic and a local favorite. Rated 4.3 out of 5."],
  ])("explains visit %s from its own data only", (id, request, text) => {
    expect(ruleReason(realPlace(id), request, "visit")).toBe(text);
  });

  it("reads a tag as what the data lists, never as the planner's own opinion", () => {
    const text = ruleReason(realPlace("place_002"), none, "visit");
    expect(text).toContain("Listed as a local favorite.");
    expect(text).not.toMatch(/(^|\. )A local favorite\./);
  });

  it("never names a tag twice when it is also a matched interest", () => {
    const giolitti = realPlace("place_011");
    expect(ruleReason(giolitti, { interests: ["local-favorite"], mustInclude: [] }, "visit")).toBe(
      "Matches your interest in local favorite. Listed as iconic. Rated 4.3 out of 5.",
    );
  });

  it("says a meal is close to the previous stop only when that stop is a walk away", () => {
    const enzo = realPlace("place_003");
    const request = { interests: ["food"], mustInclude: [] };
    expect(ruleReason(enzo, request, "dinner", realPlace("place_002"))).toBe(
      "Close to your previous stop. Matches your interest in food. Listed as a local favorite. Rated 4.6 out of 5.",
    );
    expect(ruleReason(enzo, request, "lunch", realPlace("place_026"))).toBe(
      "Matches your interest in food. Listed as a local favorite. Rated 4.6 out of 5.",
    );
    expect(ruleReason(enzo, request, "lunch", null)).not.toContain("close to");
    expect(ruleReason(enzo, request, "visit", realPlace("place_002"))).not.toContain("Close to");
  });

  it("never opens a meal with the meal, type and area the row already prints", () => {
    const market = { interests: ["market", "food", "budget", "morning"], mustInclude: [] };
    expect(ruleReason(realPlace("place_015"), market, "lunch")).toBe(
      "Matches your interest in market, food and budget. Listed as a local favorite. Rated 4.7 out of 5.",
    );
    expect(ruleReason(realPlace("place_068"), none, "dinner", realPlace("place_075"))).toBe(
      "Close to your previous stop. Listed as a local favorite. Rated 4.8 out of 5.",
    );
  });

  it("never says 'Dinner in Ostiense' for Eataly: the meal and area are on the row", () => {
    const eataly = realPlace("place_099");
    expect(eataly.type).toBe("shop");
    expect(ruleReason(eataly, none, "dinner")).toBe("Rated 4.1 out of 5.");
    expect(ruleReason(eataly, none, "lunch")).not.toContain("Ostiense");
  });

  it.each([
    [4.75, "Rated 4.8 out of 5."],
    [5, "Rated 5 out of 5."],
    [0, "Rated 0 out of 5."],
  ])("rounds a rating of %s to one decimal: %j", (rating, sentence) => {
    expect(ruleReason(makePlace({ rating }), none, "visit")).toContain(sentence);
  });

  it("falls back to 'Suggested stop.' when the place has no rating and nothing else applies", () => {
    const text = ruleReason(makePlace({ rating: null }), none, "visit");
    expect(text).toBe("Suggested stop.");
  });

  it("makes no closeness claim when the previous position is not a real coordinate", () => {
    const text = ruleReason(realPlace("place_003"), none, "dinner", { lat: Number.NaN, lng: 12 });
    expect(text).toBe("Listed as a local favorite. Rated 4.6 out of 5.");
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

  it("never restates the meal, type and area the row prints", () => {
    for (const place of places) {
      for (const role of ROLES) {
        const request = { interests: place.tags, mustInclude: [place.id] };
        const text = ruleReason(place, request, role, place);
        expect(text).not.toMatch(/^(Lunch|Dinner) (at|in)\b/);
        expect(text).not.toContain(` in ${place.city}.`);
        if (place.neighborhood) expect(text).not.toContain(` in ${place.neighborhood}`);
      }
    }
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

  it("skips an over-long interest sentence rather than cutting a word in half", () => {
    const tag = "n".repeat(200);
    const request = { interests: [tag], mustInclude: [] };
    expect(ruleReason(makePlace({ tags: [tag], rating: 4 }), request, "visit")).toBe(
      "Rated 4 out of 5.",
    );
    expect(ruleReason(makePlace({ tags: [tag], rating: null }), request, "lunch")).toBe(
      "Lunch stop.",
    );
  });
});
