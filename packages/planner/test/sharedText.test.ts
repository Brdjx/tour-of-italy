import { describe, expect, it } from "vitest";
import { nameForms, namesPlaceOutside, normalizeWords } from "../src/placeMentions";
import { planDeterministic } from "../src/plan";
import { hasNotes, privateAiText } from "../src/privateText";
import { canonicalPlanRequest, planRequestKey } from "../src/requestKey";
import {
  summaryForPlaces,
  summaryForTrip,
  summarySentences,
  tripPlaceIds,
} from "../src/summaryText";
import type { Itinerary, TripRequest } from "../src/types";
import { makeRequest, realContext } from "./plannerFixtures";

// What the page and the API must agree on about a plan's text and options: which places a
// sentence names, the summary for the places a trip has now, what a saved trip leaves out to
// keep the traveler's notes private, and the key for a set of trip options.

const ctx = realContext();
const byName = (start: string) => {
  const found = ctx.places.find((place) => place.name.startsWith(start));
  if (!found) throw new Error(`no place starting ${start}`);
  return found;
};
const colosseum = byName("Colosseum");
const trevi = byName("Trevi Fountain");

describe("place mentions", () => {
  it("normalizes words without accents, case or punctuation", () => {
    expect(normalizeWords("  Caffè   Florian, Venezia! ")).toBe("caffe florian venezia");
  });

  it("counts full names and usable short forms, never a one-word qualifier", () => {
    expect(nameForms("The Last Supper (Cenacolo Vinciano)")).toEqual(
      expect.arrayContaining([
        "the last supper cenacolo vinciano",
        "last supper",
        "cenacolo vinciano",
      ]),
    );
    expect(nameForms("Piazza del Duomo, Florence (Exterior)")).not.toContain("exterior");
  });

  it("finds a place named outside the allowed ones, but not a name inside an allowed one", () => {
    const text = `Start at the ${colosseum.name}.`;
    expect(namesPlaceOutside(text, new Set(), ctx)).toBe(true);
    expect(namesPlaceOutside(text, new Set([colosseum.id]), ctx)).toBe(false);
    expect(namesPlaceOutside("A quiet morning walk.", new Set(), ctx)).toBe(false);
  });
});

describe("the summary for a trip's places", () => {
  const summary = `The ${colosseum.name} opens the trip. The ${trevi.name} closes it! A calm pace throughout.`;

  it("splits after full stops, question and exclamation marks", () => {
    expect(summarySentences(" One.  Two? Three! ")).toEqual(["One.", "Two?", "Three!"]);
  });

  it("keeps every sentence while the trip has every place it names", () => {
    expect(summaryForPlaces(summary, new Set([colosseum.id, trevi.id]), ctx)).toBe(summary);
  });

  it("drops the sentences that name a place the trip no longer has", () => {
    expect(summaryForPlaces(summary, new Set([colosseum.id]), ctx)).toBe(
      `The ${colosseum.name} opens the trip. A calm pace throughout.`,
    );
  });

  it("is undefined without a summary or when nothing is left", () => {
    expect(summaryForPlaces(undefined, new Set(), ctx)).toBeUndefined();
    expect(summaryForPlaces(`The ${colosseum.name} is the start.`, new Set(), ctx)).toBeUndefined();
  });

  it("reads the trip's places from its days", () => {
    const plan = planDeterministic(makeRequest(), ctx);
    const ids = tripPlaceIds(plan);
    expect(ids.size).toBe(plan.days.reduce((sum, day) => sum + day.stops.length, 0));
    const first = ctx.placesById.get(plan.days[0]?.stops[0]?.placeId ?? "");
    const text = `The ${first?.name} sets the tone.`;
    expect(summaryForTrip({ ...plan, summary: text }, ctx)).toBe(text);
  });
});

describe("private AI text", () => {
  it("knows notes from an empty or missing field", () => {
    expect(hasNotes({ notes: "Travelling with a toddler" })).toBe(true);
    expect(hasNotes({ notes: "   " })).toBe(false);
    expect(hasNotes({})).toBe(false);
  });

  function planWith(notes: string | undefined): Itinerary {
    const plan = planDeterministic(makeRequest(notes === undefined ? {} : { notes }), ctx);
    const [first, second, ...rest] = plan.days[0]?.stops ?? [];
    if (!first || !second) throw new Error("unexpected fixture day");
    const days = [
      {
        ...plan.days[0],
        stops: [
          { ...first, reason: "Chosen for your slower pace.", reasonSource: "ai" as const },
          { ...second, reason: "A quiet cloister with shade.", reasonSource: "ai" as const },
          ...rest,
        ],
      },
      ...plan.days.slice(1),
    ] as Itinerary["days"];
    return { ...plan, days, summary: "Since you mentioned your knee, days stay short." };
  }

  it("leaves out the summary and every AI why line when there were notes", () => {
    // Both lines go, the one that speaks to the traveler and the one about the place.
    expect(privateAiText(planWith("I had knee surgery."))).toEqual({ summary: true, reasons: 2 });
  });

  it("leaves out nothing without notes, and no summary that is not shown", () => {
    expect(privateAiText(planWith(undefined))).toEqual({ summary: false, reasons: 0 });
    const noSummary = { ...planWith("Knee."), summary: undefined };
    expect(privateAiText(noSummary)).toEqual({ summary: false, reasons: 2 });
  });

  it("never counts a rule's why line, which a saved trip keeps", () => {
    const plan = planWith("Knee.");
    const ruled = plan.days.map((day) => ({
      ...day,
      stops: day.stops.map((stop) => ({ ...stop, reasonSource: "rule" as const })),
    }));
    expect(privateAiText({ ...plan, days: ruled }).reasons).toBe(0);
  });
});

describe("the key for a set of trip options", () => {
  const request = makeRequest({
    interests: ["food", "art"],
    anchors: ["rome", "florence"],
    mustInclude: ["b", "a"],
    exclude: ["d", "c"],
  });

  it("sorts interests, must-includes and exclusions, and keeps the bases' order and the notes", () => {
    expect(canonicalPlanRequest({ ...request, notes: " As typed " })).toEqual({
      ...request,
      interests: ["art", "food"],
      mustInclude: ["a", "b"],
      exclude: ["c", "d"],
      notes: " As typed ",
    });
    expect(canonicalPlanRequest({ ...request, anchors: "auto" }).anchors).toBe("auto");
  });

  it("gives the same key for the same options in any order and in any key order", () => {
    const reordered: TripRequest = {
      exclude: ["c", "d"],
      mustInclude: ["a", "b"],
      interests: ["art", "food"],
      anchors: ["rome", "florence"],
      maxPriceLevel: null,
      pace: request.pace,
      startDate: request.startDate,
    };
    expect(planRequestKey(reordered)).toBe(planRequestKey(request));
  });

  it("gives another key for other bases in another order, other notes or other dates", () => {
    const base = planRequestKey(request);
    expect(planRequestKey({ ...request, anchors: ["florence", "rome"] })).not.toBe(base);
    expect(planRequestKey({ ...request, notes: "Quiet" })).not.toBe(base);
    expect(planRequestKey({ ...request, startDate: "2026-11-02" })).not.toBe(base);
  });

  it("never changes the request it is given", () => {
    const copy = structuredClone(request);
    canonicalPlanRequest(request);
    expect(request).toEqual(copy);
  });
});
