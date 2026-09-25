import {
  type ItineraryMeta,
  NoFeasiblePlanError,
  planDeterministic,
  type TripRequest,
  TripRequestSchema,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type { LlmSelection } from "../../src/llm/client";
import { validSelection } from "../../src/llm/fixtureAnswers";
import { buildUserMessage } from "../../src/llm/promptUser";
import { buildShortlist, type Shortlist } from "../../src/plan/candidates";
import { materializeSelection } from "../../src/plan/materialize";
import { tidySelection } from "../../src/plan/tidy";

// The tidy step does to the model's answer what the model cannot see, because code assigns the
// times: closed places, repeats, the order of a day, the visit limit, and the day's hours. Each
// rule is pinned here on real Rome places, and so is the promise that a valid answer passes
// through untouched.

const { ctx } = shippedData();

// The trip starts on Monday 19 October 2026. Days are 0-based, as in the code: day 0 is the
// Monday, day 1 the Tuesday, day 2 the Wednesday.
const MONDAY = "2026-10-19";

const COLOSSEUM = "place_001";
const TRASTEVERE = "place_002";
const DA_ENZO = "place_003"; // lunch and dinner
const ROMAN_FORUM = "place_004";
const PANTHEON = "place_005";
const BORGHESE_GALLERY = "place_007"; // closed on Mondays
const OSTERIA_FERNANDA = "place_009"; // dinner only
const VATICAN_MUSEUMS = "place_010";
const GIOLITTI = "place_011";
const MERCATO_TESTACCIO = "place_015"; // lunch only
const TREVI_FOUNTAIN = "place_018";
const SPANISH_STEPS = "place_019";
const IL_SORPASSO = "place_020";
const ROSCIOLI = "place_022";
const AVENTINE_KEYHOLE = "place_014";
const TREVI_BY_NIGHT = "place_077"; // the same spot as the Trevi Fountain
const GIANICOLO = "place_097";
const UFFIZI = "place_026"; // a Florence place
const PIAZZALE_MICHELANGELO = "place_027";
const BUCA_MARIO = "place_029"; // lunch and dinner
const ACCADEMIA = "place_032";
const BUCA_DELL_ORAFO = "place_033"; // lunch and dinner
const SANTA_CROCE = "place_036";
const IL_LATINI = "place_039"; // lunch and dinner
const PONTE_VECCHIO = "place_084";
const DUOMO_EXTERIOR = "place_093";
const PALAZZO_VECCHIO = "place_103";

const META: ItineraryMeta = {
  model: "test",
  promptVersion: "v1",
  attempts: 1,
  latencyMs: 0,
  generatedAt: "2026-09-24T12:00:00.000Z",
};

function rome(overrides: Record<string, unknown> = {}): TripRequest {
  return TripRequestSchema.parse({
    startDate: MONDAY,
    pace: "balanced",
    anchors: ["rome"],
    ...overrides,
  });
}

function shortlistFor(request: TripRequest): Shortlist {
  let bases: string[] = [];
  try {
    bases = planDeterministic(request, ctx).days.map((day) => day.anchorId);
  } catch (error) {
    if (!(error instanceof NoFeasiblePlanError)) throw error;
  }
  return buildShortlist(request, ctx, bases);
}

/** An answer with these place ids per day, all in Rome unless a day names its base. */
function answer(...days: (string[] | { anchorId: string; placeIds: string[] })[]): LlmSelection {
  return {
    days: days.map((day) => {
      const { anchorId, placeIds } = Array.isArray(day) ? { anchorId: "rome", placeIds: day } : day;
      return {
        anchorId,
        placeIds,
        reasons: placeIds.map((placeId) => ({ placeId, reason: "Fine." })),
      };
    }),
    summary: "Three days in Rome.",
  };
}

function tidy(selection: LlmSelection, request = rome()) {
  return tidySelection(selection, request, shortlistFor(request), ctx);
}

/** The errors the check would find in the answer. */
function errorsOf(selection: LlmSelection, request = rome()) {
  return materializeSelection(selection, request, shortlistFor(request), ctx, META).errors;
}

const idsOf = (selection: LlmSelection) => selection.days.map((day) => day.placeIds);

describe("tidySelection", () => {
  it.each([
    ["Rome from a Monday", rome()],
    ["Rome with food and history", rome({ interests: ["food", "historic"] })],
    ["Florence, packed, from a Monday", rome({ anchors: ["florence"], pace: "packed" })],
    ["Venice, relaxed", rome({ anchors: ["venice"], pace: "relaxed", startDate: "2027-03-05" })],
    ["two cities with must-includes", rome({ anchors: "auto", mustInclude: [UFFIZI, PANTHEON] })],
    ["over Christmas", rome({ anchors: "auto", startDate: "2026-12-24", interests: ["art"] })],
  ])("changes nothing on a valid answer (%s)", (_, request) => {
    const shortlist = shortlistFor(request);
    const valid = validSelection(request, buildUserMessage(request, shortlist, ctx), ctx);
    expect(errorsOf(valid, request)).toEqual([]);

    const tidied = tidySelection(valid, request, shortlist, ctx);

    expect(tidied.changes).toEqual([]);
    expect(tidied.selection).toEqual(valid);
  });

  it("drops a place on its closed day, and keeps its copy on a day it is open", () => {
    const messy = answer(
      [BORGHESE_GALLERY, PANTHEON, IL_SORPASSO],
      [BORGHESE_GALLERY, COLOSSEUM, DA_ENZO],
      [VATICAN_MUSEUMS, ROSCIOLI],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "closed", day: 0, placeId: BORGHESE_GALLERY }]);
    expect(idsOf(tidied.selection)[0]).toEqual([PANTHEON, IL_SORPASSO]);
    expect(idsOf(tidied.selection)[1]).toEqual([BORGHESE_GALLERY, COLOSSEUM, DA_ENZO]);
  });

  it("keeps a must-include on its closed day when the answer has it on no other day", () => {
    // Sunday 25 October: the Vatican Museums are closed, and day 1 is the trip's only Rome day.
    // Dropped, the plan would pass without them (the validator only warns, as no Rome day is
    // open); kept, the check names the closure and the repair turn can move them.
    const request = rome({
      startDate: "2026-10-25",
      anchors: ["rome", "florence"],
      mustInclude: [VATICAN_MUSEUMS],
    });
    const florence = (placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const messy = answer(
      [VATICAN_MUSEUMS, COLOSSEUM, IL_SORPASSO, PANTHEON],
      florence([BUCA_MARIO, SANTA_CROCE, PONTE_VECCHIO, PIAZZALE_MICHELANGELO]),
      florence([ACCADEMIA, BUCA_DELL_ORAFO, PALAZZO_VECCHIO, DUOMO_EXTERIOR, IL_LATINI]),
    );
    const without = answer(
      [COLOSSEUM, IL_SORPASSO, PANTHEON],
      ...messy.days.slice(1).map((day) => florence(day.placeIds)),
    );
    expect(errorsOf(without, request)).toEqual([]);

    const tidied = tidy(messy, request);

    expect(tidied.changes.filter((c) => c.placeId === VATICAN_MUSEUMS)).toEqual([]);
    expect(idsOf(tidied.selection)[0]).toContain(VATICAN_MUSEUMS);
    // No drop mends a closure, so the day keeps every place the model chose around it.
    expect(tidied.changes.filter((c) => c.rule === "does_not_fit")).toEqual([]);
    const sorted = (ids: string[] | undefined) => [...(ids ?? [])].sort();
    expect(sorted(idsOf(tidied.selection)[0])).toEqual(sorted(idsOf(messy)[0]));
    const closure = errorsOf(tidied.selection, request).filter(
      (e) => e.placeId === VATICAN_MUSEUMS,
    );
    expect(closure.map((e) => [e.code, e.day])).toEqual([["CLOSED_AT_TIME", 0]]);
  });

  it("drops a must-include's copy on its closed day when the answer also has it on an open day", () => {
    const request = rome({ mustInclude: [BORGHESE_GALLERY] });
    const messy = answer(
      [BORGHESE_GALLERY, PANTHEON, IL_SORPASSO],
      [BORGHESE_GALLERY, COLOSSEUM, DA_ENZO],
      [VATICAN_MUSEUMS, ROSCIOLI],
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([{ rule: "closed", day: 0, placeId: BORGHESE_GALLERY }]);
    expect(idsOf(tidied.selection)[1]).toContain(BORGHESE_GALLERY);
  });

  it("drops a place that is already in the trip", () => {
    const messy = answer([PANTHEON, COLOSSEUM], [VATICAN_MUSEUMS], [ROMAN_FORUM, PANTHEON]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "duplicate", day: 2, placeId: PANTHEON }]);
    expect(idsOf(tidied.selection)[2]).toEqual([ROMAN_FORUM]);
  });

  it("drops an ordinary place at the same spot as one already in the trip", () => {
    const messy = answer([TREVI_FOUNTAIN, PANTHEON], [COLOSSEUM, TREVI_BY_NIGHT], [ROMAN_FORUM]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "same_spot", day: 1, placeId: TREVI_BY_NIGHT }]);
  });

  it("keeps a must-include's spot against an ordinary place earlier in the trip", () => {
    const request = rome({ mustInclude: [TREVI_BY_NIGHT] });
    const messy = answer([TREVI_FOUNTAIN, PANTHEON], [COLOSSEUM, TREVI_BY_NIGHT], [ROMAN_FORUM]);

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([{ rule: "same_spot", day: 0, placeId: TREVI_FOUNTAIN }]);
    expect(idsOf(tidied.selection)[1]).toContain(TREVI_BY_NIGHT);
  });

  it("keeps two must-includes at one spot, which the validator only warns about", () => {
    const request = rome({ mustInclude: [TREVI_FOUNTAIN, TREVI_BY_NIGHT] });
    const messy = answer([TREVI_FOUNTAIN, PANTHEON], [COLOSSEUM, TREVI_BY_NIGHT], [ROMAN_FORUM]);

    expect(tidy(messy, request).changes).toEqual([]);
  });

  it("drops the day's last ordinary visits over the pace's limit, never a must-include", () => {
    // Six short visits on a balanced day (at most five), with lunch and dinner.
    const day = [
      GIOLITTI,
      PANTHEON,
      TREVI_FOUNTAIN,
      IL_SORPASSO,
      SPANISH_STEPS,
      GIANICOLO,
      AVENTINE_KEYHOLE,
      DA_ENZO,
    ];
    const messy = answer([COLOSSEUM], day, [ROMAN_FORUM]);

    const plain = tidy(messy);
    const lastVisit = plain.changes.find((c) => c.rule === "over_visit_limit");
    expect(plain.changes.filter((c) => c.rule === "over_visit_limit")).toHaveLength(1);
    expect(lastVisit?.day).toBe(1);

    const asked = rome({ mustInclude: [lastVisit?.placeId ?? ""] });
    const kept = tidy(messy, asked);
    const dropped = kept.changes.filter((c) => c.rule === "over_visit_limit");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.placeId).not.toBe(lastVisit?.placeId);
    expect(idsOf(kept.selection)[1]).toContain(lastVisit?.placeId);
    expect(errorsOf(kept.selection, asked).filter((e) => e.code === "TOO_MANY_VISITS")).toEqual([]);
  });

  it("drops nothing when only must-includes are over the limit, and the check still says so", () => {
    const six = [GIOLITTI, PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS, GIANICOLO, AVENTINE_KEYHOLE];
    const request = rome({ mustInclude: six });
    const messy = answer([COLOSSEUM], six, [ROMAN_FORUM]);

    const tidied = tidy(messy, request);

    expect(tidied.changes.filter((c) => c.rule === "over_visit_limit")).toEqual([]);
    expect(errorsOf(tidied.selection, request).map((e) => e.code)).toContain("TOO_MANY_VISITS");
  });

  it("reorders a day the scheduler cannot time, into a plan that passes the check", () => {
    const scrambled = [
      OSTERIA_FERNANDA,
      MERCATO_TESTACCIO,
      VATICAN_MUSEUMS,
      COLOSSEUM,
      TREVI_BY_NIGHT,
    ];
    const messy = answer([PANTHEON, ROSCIOLI], scrambled, [ROMAN_FORUM, DA_ENZO]);
    expect(errorsOf(messy).length).toBeGreaterThan(0);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 1 }]);
    expect([...(idsOf(tidied.selection)[1] ?? [])].sort()).toEqual([...scrambled].sort());
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("keeps the model's order when neither walk times the day better", () => {
    // Roscioli after dinner at Da Enzo runs past the day's end in every order, so it goes for
    // not fitting: a second restaurant is not a meal the day needs. The rest keep their order.
    const day = [GIANICOLO, GIOLITTI, VATICAN_MUSEUMS, DA_ENZO, ROSCIOLI];
    const messy = answer([PANTHEON], day, [ROMAN_FORUM]);
    expect(errorsOf(messy).length).toBeGreaterThan(0);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "does_not_fit", day: 1, placeId: ROSCIOLI }]);
    expect(idsOf(tidied.selection)[1]).toEqual(day.slice(0, -1));
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  // Tuesday: the Colosseum, the Forum, the Borghese Gallery, and four hours in the Vatican
  // Museums, with lunch at Da Enzo, are more than one day's opening hours hold.
  const OVER_HOURS = [COLOSSEUM, DA_ENZO, ROMAN_FORUM, BORGHESE_GALLERY, VATICAN_MUSEUMS];

  it("drops the last ordinary visit of a day its hours cannot hold, and the day then times cleanly", () => {
    const messy = answer([SPANISH_STEPS], OVER_HOURS, [TRASTEVERE]);
    const codes = errorsOf(messy).map((e) => [e.code, e.placeId]);
    expect(codes).toEqual([
      ["CLOSED_AT_TIME", VATICAN_MUSEUMS],
      ["OUTSIDE_DAY_WINDOW", VATICAN_MUSEUMS],
    ]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "does_not_fit", day: 1, placeId: VATICAN_MUSEUMS }]);
    expect(idsOf(tidied.selection)[1]).toEqual(OVER_HOURS.slice(0, -1));
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("never drops a must-include to make a day fit: an ordinary visit goes instead", () => {
    const request = rome({ mustInclude: [VATICAN_MUSEUMS] });
    const messy = answer([SPANISH_STEPS], OVER_HOURS, [TRASTEVERE]);

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      { rule: "does_not_fit", day: 1, placeId: BORGHESE_GALLERY },
      { rule: "reordered", day: 1 },
    ]);
    expect(idsOf(tidied.selection)[1]).toContain(VATICAN_MUSEUMS);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
  });

  it("drops the visit that does not fit, not a later one that does", () => {
    // Tuesday: after lunch and the Borghese Gallery, the Vatican Museums would run 17:00 to
    // 21:00, past closing. The Aventine Keyhole after them fits, so it stays.
    const day = [DA_ENZO, BORGHESE_GALLERY, VATICAN_MUSEUMS, AVENTINE_KEYHOLE];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);
    const codes = errorsOf(messy).map((e) => [e.code, e.placeId]);
    expect(codes).toEqual([["CLOSED_AT_TIME", VATICAN_MUSEUMS]]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "does_not_fit", day: 1, placeId: VATICAN_MUSEUMS }]);
    expect(idsOf(tidied.selection)[1]).toEqual([DA_ENZO, BORGHESE_GALLERY, AVENTINE_KEYHOLE]);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("keeps the restaurant a day needs for lunch, and drops a visit instead", () => {
    // Mercato Testaccio serves lunch only and closes at 14:00. In the model's order, and in the
    // order each walk finds, it comes after the Borghese Gallery and the Trevi Fountain, too late
    // for lunch. It is the day's only lunch place, so the Trevi Fountain goes, and the market is
    // lunch.
    const day = [BORGHESE_GALLERY, TREVI_FOUNTAIN, MERCATO_TESTACCIO];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);
    const codes = errorsOf(messy).map((e) => [e.code, e.placeId]);
    expect(codes).toEqual([["CLOSED_AT_TIME", MERCATO_TESTACCIO]]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "does_not_fit", day: 1, placeId: TREVI_FOUNTAIN }]);
    const made = materializeSelection(tidied.selection, rome(), shortlistFor(rome()), ctx, META);
    expect(made.errors).toEqual([]);
    const stops = made.itinerary.days[1]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(stops).toEqual([
      [BORGHESE_GALLERY, "visit"],
      [MERCATO_TESTACCIO, "lunch"],
    ]);
  });

  it("changes nothing on a full day that already fits its hours", () => {
    const full = [COLOSSEUM, DA_ENZO, ROMAN_FORUM, BORGHESE_GALLERY, OSTERIA_FERNANDA];
    const fits = answer([SPANISH_STEPS], full, [TRASTEVERE]);
    expect(errorsOf(fits)).toEqual([]);

    const tidied = tidy(fits);

    expect(tidied.changes).toEqual([]);
    expect(tidied.selection).toEqual(fits);
  });

  it("only drops closed and repeated places on a day it cannot judge", () => {
    const scrambled = [OSTERIA_FERNANDA, MERCATO_TESTACCIO, VATICAN_MUSEUMS, COLOSSEUM];
    const messy = answer(
      ["place_999", BORGHESE_GALLERY, ...scrambled],
      [...scrambled.slice(0, 1), UFFIZI, TRASTEVERE, ...scrambled.slice(1)],
      { anchorId: "atlantis", placeIds: [PANTHEON, PANTHEON] },
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([
      { rule: "closed", day: 0, placeId: BORGHESE_GALLERY },
      { rule: "closed", day: 0, placeId: OSTERIA_FERNANDA },
      { rule: "duplicate", day: 1, placeId: MERCATO_TESTACCIO },
      { rule: "duplicate", day: 1, placeId: VATICAN_MUSEUMS },
      { rule: "duplicate", day: 1, placeId: COLOSSEUM },
      { rule: "duplicate", day: 2, placeId: PANTHEON },
    ]);
    expect(idsOf(tidied.selection)).toEqual([
      ["place_999", MERCATO_TESTACCIO, VATICAN_MUSEUMS, COLOSSEUM],
      [OSTERIA_FERNANDA, UFFIZI, TRASTEVERE],
      [PANTHEON],
    ]);
  });

  it("never changes a base or the input, and never adds a place", () => {
    const messy = answer(
      [BORGHESE_GALLERY, OSTERIA_FERNANDA, PANTHEON, TREVI_FOUNTAIN],
      [TREVI_BY_NIGHT, MERCATO_TESTACCIO, VATICAN_MUSEUMS, COLOSSEUM, PANTHEON],
      [DA_ENZO, ROMAN_FORUM, GIOLITTI],
    );
    const before = structuredClone(messy);

    const tidied = tidy(messy);

    expect(messy).toEqual(before);
    expect(tidied.changes.length).toBeGreaterThan(0);
    tidied.selection.days.forEach((day, index) => {
      const original = before.days[index];
      expect(day.anchorId).toBe(original?.anchorId);
      expect(day.reasons).toEqual(original?.reasons);
      for (const id of day.placeIds) expect(original?.placeIds).toContain(id);
    });
    expect(tidied.selection.summary).toBe(before.summary);
  });
});
