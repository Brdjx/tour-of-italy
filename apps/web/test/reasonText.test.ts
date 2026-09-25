import { PACES, type Place, ruleReason } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { placeSubtitle } from "../lib/format";
import { displayReason } from "../lib/reasonText";
import { buildTripView } from "../lib/timetable";
import { ctx, fixturePlan, place } from "./fixtures";

// The "why" line must add something: a rule reason that only repeats the subtitle and rating
// printed above it tells the traveler nothing. Only exact repeats may go; anything new stays.
// The planner no longer opens with the type and area or the meal, but plans saved in the browser
// or shared before that change still do, so those tests use the old wording as it was written.

const NO_REQUEST = { interests: [], mustInclude: [] };
const visit = (p: Place) => ({ place: p, role: "visit" as const, ratingShown: true });

describe("displayReason", () => {
  it("drops the type-and-area and rating sentences the row already shows", () => {
    const cafe = place("place_011"); // Giolitti, a cafe in Pigna rated 4.3
    const raw = "Cafe in Pigna. Rated 4.3 out of 5. A local favorite."; // an old saved plan
    expect(raw).toContain(`${placeSubtitle(cafe)}.`);
    const shown = displayReason(raw, false, visit(cafe));
    expect(shown).toBe("A local favorite.");
    const now = displayReason(ruleReason(cafe, NO_REQUEST, "visit"), false, visit(cafe));
    expect(now).toBe("Listed as iconic and a local favorite.");
  });

  it("keeps what is new: interests, must-see and the local favorite listing", () => {
    const favorite = [...ctx.places].find((p) => p.tags.includes("local-favorite")) as Place;
    const tag = favorite.tags.find((t) => t !== "local-favorite") as string;
    const raw = ruleReason(favorite, { interests: [tag], mustInclude: [favorite.id] }, "visit");
    const shown = displayReason(raw, false, visit(favorite)) ?? "";
    expect(shown).toContain("You asked to include this.");
    expect(shown).toContain("Matches your interest in");
    expect(shown).toContain("Listed as a local favorite.");
  });

  it("keeps the rating sentence where the rating is not printed (the swap sheet)", () => {
    const rated = [...ctx.places].find((p) => p.rating !== null) as Place;
    const raw = ruleReason(rated, NO_REQUEST, "visit");
    const shown = displayReason(raw, false, { place: rated, role: "visit", ratingShown: false });
    expect(shown).toMatch(/Rated [\d.]+ out of 5\./);
  });

  it("turns a meal lead into its only news, the closeness to the previous stop", () => {
    const restaurant = [...ctx.places].find((p) => p.type === "restaurant") as Place;
    const context = { place: restaurant, role: "dinner" as const, ratingShown: true };
    const old = `Dinner at a restaurant in ${restaurant.neighborhood}, close to your previous stop.`;
    expect(displayReason(old, false, context)).toBe("Close to your previous stop.");
    const raw = ruleReason(restaurant, NO_REQUEST, "dinner", restaurant);
    expect(raw).toMatch(/^Close to your previous stop\./);
    expect(displayReason(raw, false, context)).toMatch(/^Close to your previous stop\./);
  });

  it("hides the line when nothing new is left", () => {
    const plain = [...ctx.places].find(
      (p) => p.type === "museum" && !p.tags.some((t) => t === "local-favorite" || t === "iconic"),
    ) as Place;
    expect(displayReason(ruleReason(plain, NO_REQUEST, "visit"), false, visit(plain))).toBeNull();
    expect(displayReason("Suggested stop.", false, visit(plain))).toBeNull();
  });

  it("leaves AI reasons exactly as written", () => {
    const text = "Museum in Florence. Rated 4.8 out of 5. Go early.";
    expect(displayReason(text, true, visit(place("place_001")))).toBe(text);
  });

  it("never drops a sentence that only resembles a repeat", () => {
    const cafe = [...ctx.places].find((p) => p.type === "cafe") as Place;
    const text = `${placeSubtitle(cafe)} is where locals meet.`;
    expect(displayReason(text, false, visit(cafe))).toBe(text);
  });

  it("leaves no repeated subtitle or rating in any rule reason of real plans", () => {
    let shortened = 0;
    for (const pace of PACES) {
      for (const interests of [[], ["food"], ["art", "history"]]) {
        const plan = fixturePlan({ pace, interests });
        for (const day of buildTripView(plan, ctx, [])) {
          for (const row of day.rows) {
            if (!row.place || row.stop.reasonSource === "ai") continue;
            const text = row.reason ?? "";
            expect(text).not.toContain(`${placeSubtitle(row.place)}.`);
            expect(text).not.toMatch(/^Rated [\d.]+ out of 5\.|\. Rated [\d.]+ out of 5\./);
            if (text !== (row.stop.reason ?? "")) shortened += 1;
          }
        }
      }
    }
    expect(shortened).toBeGreaterThan(20);
  });
});
