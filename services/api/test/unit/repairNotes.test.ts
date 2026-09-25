import { TripRequestSchema } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type { LlmSelection } from "../../src/llm/client";
import { buildShortlist } from "../../src/plan/candidates";
import { repairNotes } from "../../src/plan/repairNotes";
import type { TidyChange } from "../../src/plan/tidy";

// The repair turn's account of what the tidy step did: every removal with its reason in words,
// every move, and each empty day with the candidates still free for it. Days are 0-based in the
// changes and 1-based in the text, as the model reads them.

const { ctx } = shippedData();

// Monday 19 to Wednesday 21 October 2026, Rome, balanced.
const REQUEST = TripRequestSchema.parse({
  startDate: "2026-10-19",
  pace: "balanced",
  anchors: ["rome"],
});
const SHORTLIST = buildShortlist(REQUEST, ctx);

function trip(...days: string[][]): LlmSelection {
  return {
    days: days.map((placeIds) => ({ anchorId: "rome", placeIds, reasons: [] })),
    summary: "",
  };
}

function notes(selection: LlmSelection, changes: TidyChange[], shortlist = SHORTLIST) {
  return repairNotes({ selection, changes }, REQUEST, shortlist, ctx);
}

describe("repairNotes", () => {
  it("says why each stop was removed, and skips a reordered day", () => {
    const selection = trip(["place_018", "place_005"], ["place_001", "place_011"], ["place_004"]);

    const result = notes(selection, [
      { rule: "closed", day: 0, placeId: "place_007" },
      { rule: "duplicate", day: 2, placeId: "place_005" },
      { rule: "duplicate", day: 2, placeId: "place_020" },
      { rule: "same_spot", day: 1, placeId: "place_077" },
      { rule: "same_spot", day: 1, placeId: "place_010" },
      { rule: "over_visit_limit", day: 1, placeId: "place_014" },
      { rule: "does_not_fit", day: 2, placeId: "place_097" },
      { rule: "reordered", day: 1 },
    ]);

    expect(result.removed).toEqual([
      "day 1, place_007: closed on Monday 2026-10-19",
      "day 3, place_005: already on day 1; each id may appear once in the trip",
      "day 3, place_020: used on another day as well; each id may appear once in the trip",
      "day 2, place_077: the same spot as place_018 on day 1",
      "day 2, place_010: the same spot as another stop in the trip",
      "day 2, place_014: day 2 had more visits than the balanced pace allows (5 a day, not counting meals)",
      "day 3, place_097: day 3's opening hours and travel time could not hold it",
    ]);
    expect(result.moved).toEqual([]);
    expect(result.emptyDays).toEqual([]);
  });

  it("lists each move with the day it left and the day it joined", () => {
    const selection = trip(["place_001"], ["place_004"], ["place_011"]);

    const result = notes(selection, [
      { rule: "moved_day", day: 1, placeId: "place_011", toDay: 2, cause: "over_visit_limit" },
    ]);

    expect(result).toEqual({
      removed: [],
      moved: ["place_011 from day 2 to day 3"],
      emptyDays: [],
    });
  });

  it("names the candidates still free for an empty day: open that date, and not at a used spot", () => {
    // The Trevi Fountain is in the trip, so neither it nor the fountain by night is free. The
    // Borghese Gallery is closed on the Monday.
    const selection = trip([], ["place_018"], ["place_005"]);

    const [line] = notes(selection, []).emptyDays;

    const head = "Day 1 (rome, Monday 2026-10-19) has no stops left.";
    expect(line?.startsWith(`${head} Candidates at rome open that day and not in the trip: `)).toBe(
      true,
    );
    for (const id of ["place_018", "place_077", "place_005", "place_007"]) {
      expect(line).not.toContain(`${id},`);
      expect(line?.endsWith(`${id}.`)).toBe(false);
    }
    expect(line).toContain("place_001");
    expect(line).toContain("place_020 (meal)");
  });

  it("says when nothing is free for an empty day, even at a base that was not offered", () => {
    const none = {
      ...SHORTLIST,
      options: SHORTLIST.options.map((o) => ({ ...o, candidates: [] })),
    };
    const selection = trip(["place_001"], [], ["place_004"]);
    const elsewhere: LlmSelection = {
      ...selection,
      days: selection.days.map((day, i) => (i === 1 ? { ...day, anchorId: "atlantis" } : day)),
    };

    expect(notes(selection, [], none).emptyDays).toEqual([
      "Day 2 (rome, Tuesday 2026-10-20) has no stops left. No candidate at rome open that day is free, so move stops to it from other days, or give it another base.",
    ]);
    expect(notes(elsewhere, []).emptyDays[0]).toContain("No candidate at atlantis");
  });
});
