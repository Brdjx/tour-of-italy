import {
  buildPlannerContext,
  type ItineraryMeta,
  NoFeasiblePlanError,
  planDeterministic,
  scheduleDay,
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
import { type MovableRule, tidySelection } from "../../src/plan/tidy";

// The tidy step does to the model's answer what the model cannot see, because code assigns the
// times: closed places, repeats, the order of a day, the visit limit, and the day's hours, and it
// puts back a place dropped for the hours where another position holds it, and a restaurant only
// as a meal the day lacks. What a day cannot hold moves to another day at its base that holds it,
// and a day that repeats would empty keeps one of its places. A day's meal places go where their
// meals happen, a restaurant over the budget is only ever a meal, and of a restaurant and a visit
// at one spot the restaurant stays when the trip needs its meal. Each rule is pinned here on real
// places, most in Rome and some in Florence, Venice and Bologna, and so is the promise that a valid
// answer passes through untouched. Most answers here have short other days, so a place one day
// drops moves to one of them (step 8); the day's own result is what each test is about.

const { ctx } = shippedData();

// The trip starts on Monday 19 October 2026. Days are 0-based, as in the code: day 0 is the
// Monday, day 1 the Tuesday, day 2 the Wednesday.
const MONDAY = "2026-10-19";

const COLOSSEUM = "place_001";
const TRASTEVERE = "place_002";
const DA_ENZO = "place_003"; // lunch and dinner
const ROMAN_FORUM = "place_004";
const PANTHEON = "place_005";
const CAMPO_DE_FIORI = "place_006";
const BORGHESE_GALLERY = "place_007"; // closed on Mondays
const PIAZZA_NAVONA = "place_008";
const OSTERIA_FERNANDA = "place_009"; // dinner only
const VATICAN_MUSEUMS = "place_010";
const GIOLITTI = "place_011";
const MERCATO_TESTACCIO = "place_015"; // lunch only
const PALATINE_HILL = "place_016";
const CASTEL_SANT_ANGELO = "place_017";
const TREVI_FOUNTAIN = "place_018";
const SPANISH_STEPS = "place_019";
const IL_SORPASSO = "place_020";
const ROSCIOLI = "place_022";
const AVENTINE_KEYHOLE = "place_014";
const TREVI_BY_NIGHT = "place_077"; // the same spot as the Trevi Fountain
const GIANICOLO = "place_097";
const TRATTORIA_DA_CESARE = "place_042"; // lunch and dinner, closed on Mondays
const EATALY = "place_099"; // lunch and dinner
const BORGHESE_PARK = "place_080";
const UFFIZI = "place_026"; // a Florence place
const PIAZZALE_MICHELANGELO = "place_027";
const OLTRARNO = "place_028";
const BUCA_MARIO = "place_029"; // lunch and dinner
const MERCATO_CENTRALE = "place_030"; // closed on Sundays
const MERCATO_CENTRALE_FOOD_HALL = "place_031"; // the same spot as the Mercato Centrale
const ACCADEMIA = "place_032";
const BUCA_DELL_ORAFO = "place_033"; // lunch and dinner
const SANTA_CROCE = "place_036";
const BOBOLI_GARDENS = "place_034";
const RASPUTIN = "place_037"; // dinner only
const IL_LATINI = "place_039"; // lunch and dinner
const SAN_MINIATO = "place_040";
const OSTERIA_ENOTECA = "place_041"; // dinner only
const OSTERIA_FRANCESCANA = "place_043"; // a Bologna place, dinner only, in Modena
const BALSAMIC_TASTING = "place_044"; // in Modena
const VIA_DRAPPERIE = "place_046"; // lunch only
const TORRE_ASINELLI = "place_048";
const PINACOTECA = "place_051";
const PIAZZA_MAGGIORE_BY_NIGHT = "place_052";
const PROSCIUTTO_DI_PARMA = "place_092"; // lunch only, in Parma
const PITTI_PALACE = "place_081";
const PIENZA_DAY_TRIP = "place_089";
const PONTE_VECCHIO = "place_084";
const DUOMO_EXTERIOR = "place_093";
const BARGELLO = "place_101"; // open 08:15 to 13:50
const PALAZZO_VECCHIO = "place_103";
const RIALTO_BRIDGE = "place_066"; // a Venice place
const DOGES_PALACE = "place_067";
const CICCHETTI_CRAWL = "place_068"; // dinner only
const GUGGENHEIM = "place_069"; // open 10:00 to 18:00
const DORSODURO = "place_072";
const OSTERIA_DA_RIOBA = "place_073"; // lunch and dinner
const ST_MARKS_BASILICA = "place_074";
const OSTERIA_ALLA_STAFFA = "place_076"; // lunch and dinner
const SAN_GIORGIO_CAMPANILE = "place_088";
const AL_QUADRI = "place_096"; // lunch and dinner

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

/** The record of a place that left `day` for `toDay` (step 8), and the rule that took it off. */
const moved = (day: number, placeId: string, toDay: number, cause: MovableRule) => ({
  rule: "moved_day",
  day,
  placeId,
  toDay,
  cause,
});

/**
 * Each day's changes list exactly the places the tidied day left out of the model's, and each
 * place a day gained is a move to it.
 */
function expectDropsListed(messy: LlmSelection, tidied: ReturnType<typeof tidy>) {
  messy.days.forEach((day, index) => {
    const kept = idsOf(tidied.selection)[index] ?? [];
    const left = day.placeIds.filter((id) => !kept.includes(id));
    const listed = tidied.changes
      .filter((change) => change.day === index && change.rule !== "reordered")
      .map((change) => change.placeId);
    expect([...left].sort()).toEqual([...listed].sort());
    const joined = kept.filter((id) => !day.placeIds.includes(id));
    const movedIn = tidied.changes
      .filter((change) => change.rule === "moved_day" && change.toDay === index)
      .map((change) => change.placeId);
    expect([...joined].sort()).toEqual([...movedIn].sort());
  });
}

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
      [BORGHESE_GALLERY, IL_SORPASSO, PANTHEON],
      [BORGHESE_GALLERY, COLOSSEUM, DA_ENZO],
      [VATICAN_MUSEUMS, ROSCIOLI],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "closed", day: 0, placeId: BORGHESE_GALLERY }]);
    expect(idsOf(tidied.selection)[0]).toEqual([IL_SORPASSO, PANTHEON]);
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
      [BORGHESE_GALLERY, IL_SORPASSO, PANTHEON],
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

    // The Aventine Keyhole, the sixth visit, leaves day 1; day 0 has room, so it moves there.
    const plain = tidy(messy);
    expect(plain.changes).toEqual([moved(1, AVENTINE_KEYHOLE, 0, "over_visit_limit")]);
    expectDropsListed(messy, plain);

    const asked = rome({ mustInclude: [AVENTINE_KEYHOLE] });
    const kept = tidy(messy, asked);
    const left = kept.changes.filter((c) => c.day === 1);
    expect(left).toHaveLength(1);
    expect(left[0]?.placeId).not.toBe(AVENTINE_KEYHOLE);
    expect(idsOf(kept.selection)[1]).toContain(AVENTINE_KEYHOLE);
    expect(errorsOf(kept.selection, asked).filter((e) => e.code === "TOO_MANY_VISITS")).toEqual([]);
  });

  it("leaves out what a day cannot hold when every other day at its base is full", () => {
    // A relaxed Monday to Wednesday: three visits a day, and days 0 and 2 have three each. Day 1's
    // fourth visit goes for the limit and the Borghese Gallery for the hours, and neither has a
    // day to move to (the gallery is closed on the Monday too).
    const request = rome({ pace: "relaxed" });
    const messy = answer(
      [PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS],
      [COLOSSEUM, VATICAN_MUSEUMS, BORGHESE_GALLERY, AVENTINE_KEYHOLE],
      [ROMAN_FORUM, GIANICOLO, TRASTEVERE],
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      { rule: "over_visit_limit", day: 1, placeId: AVENTINE_KEYHOLE },
      { rule: "does_not_fit", day: 1, placeId: BORGHESE_GALLERY },
    ]);
    expect(idsOf(tidied.selection)).toEqual([
      [PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS],
      [COLOSSEUM, VATICAN_MUSEUMS],
      [ROMAN_FORUM, GIANICOLO, TRASTEVERE],
    ]);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
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

  it("seats a restaurant the day's order times as a visit where it is the lunch the day lacks", () => {
    // Monday: after the Pantheon, Il Sorpasso would start at 10:50, before lunch, so it would be
    // a visit and the day would have no lunch. First, it is lunch at noon, and the Pantheon follows.
    const messy = answer(
      [PANTHEON, IL_SORPASSO],
      [COLOSSEUM, DA_ENZO],
      [VATICAN_MUSEUMS, ROSCIOLI],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 0 }]);
    const made = materializeSelection(tidied.selection, rome(), shortlistFor(rome()), ctx, META);
    expect(made.errors).toEqual([]);
    const stops = made.itinerary.days[0]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(stops).toEqual([
      [IL_SORPASSO, "lunch"],
      [PANTHEON, "visit"],
    ]);
  });

  it("leaves a restaurant timed as a visit where it is when the day has the meals it serves", () => {
    // Wednesday: Il Sorpasso after lunch at Roscioli is a visit, and the day has lunch and dinner.
    const day = [COLOSSEUM, ROSCIOLI, IL_SORPASSO, OSTERIA_FERNANDA];
    const messy = answer([SPANISH_STEPS], [TRASTEVERE], day);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([]);
    expect(idsOf(tidied.selection)[2]).toEqual(day);
  });

  it("keeps the model's order when neither walk times the day better", () => {
    // Roscioli after dinner at Da Enzo runs past the day's end in every order, so it goes for
    // not fitting: a second restaurant is not a meal the day needs. The rest keep their order.
    // Day 0 has no meal, so Roscioli moves there as one.
    const day = [GIANICOLO, GIOLITTI, VATICAN_MUSEUMS, DA_ENZO, ROSCIOLI];
    const messy = answer([PANTHEON], day, [ROMAN_FORUM]);
    expect(errorsOf(messy).length).toBeGreaterThan(0);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([moved(1, ROSCIOLI, 0, "does_not_fit")]);
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

    // Day 0, with the Spanish Steps alone, holds the four hours of the museums: they move there.
    expect(tidied.changes).toEqual([moved(1, VATICAN_MUSEUMS, 0, "does_not_fit")]);
    expect(idsOf(tidied.selection)[1]).toEqual(OVER_HOURS.slice(0, -1));
    expect(idsOf(tidied.selection)[0]).toEqual([SPANISH_STEPS, VATICAN_MUSEUMS]);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("never drops a must-include to make a day fit: an ordinary visit goes instead", () => {
    const request = rome({ mustInclude: [VATICAN_MUSEUMS] });
    const messy = answer([SPANISH_STEPS], OVER_HOURS, [TRASTEVERE]);

    const tidied = tidy(messy, request);

    // The gallery is closed on the Monday, day 0, so it moves to the Wednesday.
    expect(tidied.changes).toEqual([
      moved(1, BORGHESE_GALLERY, 2, "does_not_fit"),
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

    expect(tidied.changes).toEqual([moved(1, VATICAN_MUSEUMS, 0, "does_not_fit")]);
    expect(idsOf(tidied.selection)[1]).toEqual([DA_ENZO, BORGHESE_GALLERY, AVENTINE_KEYHOLE]);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("keeps the restaurant a day needs for lunch, and puts the visit dropped for it back after lunch", () => {
    // Mercato Testaccio serves lunch only and closes at 14:00. In the model's order, and in the
    // order each walk finds, it comes after the Borghese Gallery and the Trevi Fountain, too late
    // for lunch. It is the day's only lunch place, so the Trevi Fountain goes, and the market is
    // lunch. The Trevi Fountain then fits after lunch, so it goes back there: all three stay,
    // in another order.
    const day = [BORGHESE_GALLERY, TREVI_FOUNTAIN, MERCATO_TESTACCIO];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);
    const codes = errorsOf(messy).map((e) => [e.code, e.placeId]);
    expect(codes).toEqual([["CLOSED_AT_TIME", MERCATO_TESTACCIO]]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 1 }]);
    const made = materializeSelection(tidied.selection, rome(), shortlistFor(rome()), ctx, META);
    expect(made.errors).toEqual([]);
    const stops = made.itinerary.days[1]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(stops).toEqual([
      [BORGHESE_GALLERY, "visit"],
      [MERCATO_TESTACCIO, "lunch"],
      [TREVI_FOUNTAIN, "visit"],
    ]);
  });

  it("puts a dropped museum that closes early back as the day's first stop", () => {
    // Tuesday in Florence. After three hours in the Uffizi, the Bargello would start at 12:55 and
    // run past its 13:50 closing, and both walks take the Uffizi first too, so the drop loop takes
    // the Bargello out. As the first stop it fits, 09:35 to 11:05, and the rest of the day still
    // times cleanly.
    const request = rome({ anchors: ["florence"] });
    const florence = (placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const messy = answer(
      florence([PONTE_VECCHIO]),
      florence([UFFIZI, BARGELLO, SANTA_CROCE]),
      florence([ACCADEMIA]),
    );
    const codes = errorsOf(messy, request).map((e) => [e.code, e.placeId]);
    expect(codes).toEqual([["CLOSED_AT_TIME", BARGELLO]]);

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 1 }]);
    expect(idsOf(tidied.selection)[1]).toEqual([BARGELLO, UFFIZI, SANTA_CROCE]);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    const first = made.itinerary.days[1]?.stops[0];
    expect([first?.placeId, first?.start, first?.end]).toEqual([
      BARGELLO,
      9 * 60 + 35,
      11 * 60 + 5,
    ]);
  });

  it("does not put back a visit dropped for the hours when no position in the day holds it", () => {
    // The four hours of the Vatican Museums fit nowhere in OVER_HOURS without an error: the
    // check fails at every position of the tidied day. They move to day 0 instead.
    const messy = answer([SPANISH_STEPS], OVER_HOURS, [TRASTEVERE]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([moved(1, VATICAN_MUSEUMS, 0, "does_not_fit")]);
    const kept = idsOf(tidied.selection)[1] ?? [];
    for (let at = 0; at <= kept.length; at++) {
      const day = [...kept.slice(0, at), VATICAN_MUSEUMS, ...kept.slice(at)];
      expect(errorsOf(answer([SPANISH_STEPS], day, [TRASTEVERE])).length).toBeGreaterThan(0);
    }
  });

  // Monday: after lunch and the afternoon, the Vatican Museums would run 17:15 to 21:15, an
  // outing through dinner, and Roscioli after them runs past the day's end.
  const LOST_DINNER = [PANTHEON, DA_ENZO, IL_SORPASSO, SPANISH_STEPS, VATICAN_MUSEUMS, ROSCIOLI];

  it("puts back a restaurant dropped while an outing stood in for its meal", () => {
    // The drop loop takes Roscioli first: the museums cover dinner, so it is not a meal the day
    // needs. Then the museums go too (closed by then), and the day has no dinner. Put back,
    // Roscioli is dinner.
    const messy = answer(LOST_DINNER, [AVENTINE_KEYHOLE], [TRASTEVERE]);
    const without = answer(
      LOST_DINNER.filter((id) => id !== VATICAN_MUSEUMS && id !== ROSCIOLI),
      [AVENTINE_KEYHOLE],
      [TRASTEVERE],
    );
    const bare = materializeSelection(without, rome(), shortlistFor(rome()), ctx, META);
    expect(bare.errors).toEqual([]);
    expect(bare.itinerary.warnings.filter((w) => w.day === 0).map((w) => w.detail)).toEqual([
      "Day 1 has no dinner stop.",
    ]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([moved(0, VATICAN_MUSEUMS, 1, "does_not_fit")]);
    const made = materializeSelection(tidied.selection, rome(), shortlistFor(rome()), ctx, META);
    expect(made.errors).toEqual([]);
    expect(made.itinerary.warnings.filter((w) => w.day === 0)).toEqual([]);
    const last = made.itinerary.days[0]?.stops.at(-1);
    expect([last?.placeId, last?.role]).toEqual([ROSCIOLI, "dinner"]);
  });

  it("puts a place back where it moves the day's other stops least", () => {
    // Tuesday. In the model's order the Borghese Gallery comes last, 17:50 to 19:50, past its
    // 19:00 closing, so it goes, and Il Sorpasso becomes dinner. It fits first thing in the
    // morning, but the three stops before dinner would then start 2 hours 40 minutes later; after
    // the Trevi Fountain, no stop moves.
    const day = [GIOLITTI, VATICAN_MUSEUMS, TREVI_FOUNTAIN, IL_SORPASSO, BORGHESE_GALLERY];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);
    const without = answer([SPANISH_STEPS], day.slice(0, -1), [TRASTEVERE]);
    const startsOf = (selection: LlmSelection) => {
      const made = materializeSelection(selection, rome(), shortlistFor(rome()), ctx, META);
      expect(made.errors).toEqual([]);
      return new Map(made.itinerary.days[1]?.stops.map((stop) => [stop.placeId, stop.start]));
    };

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 1 }]);
    expect(idsOf(tidied.selection)[1]).toEqual([
      GIOLITTI,
      VATICAN_MUSEUMS,
      TREVI_FOUNTAIN,
      BORGHESE_GALLERY,
      IL_SORPASSO,
    ]);
    const after = startsOf(tidied.selection);
    for (const [placeId, start] of startsOf(without)) expect(after.get(placeId)).toBe(start);
  });

  it("puts a place back where it gives the day a meal it lacked, before moving least", () => {
    // Tuesday. The drop loop leaves the Trevi Fountain and Mercato Testaccio, a morning visit at
    // 10:45 with no lunch that day. The Borghese Gallery goes back after them, where nothing
    // moves. The Roman Forum fits at the end as well, but between the two it brings the market to
    // 12:35, as lunch.
    const day = [TREVI_FOUNTAIN, BORGHESE_GALLERY, MERCATO_TESTACCIO, ROMAN_FORUM, VATICAN_MUSEUMS];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([
      moved(1, VATICAN_MUSEUMS, 0, "does_not_fit"),
      { rule: "reordered", day: 1 },
    ]);
    const made = materializeSelection(tidied.selection, rome(), shortlistFor(rome()), ctx, META);
    expect(made.errors).toEqual([]);
    const stops = made.itinerary.days[1]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(stops).toEqual([
      [TREVI_FOUNTAIN, "visit"],
      [ROMAN_FORUM, "visit"],
      [MERCATO_TESTACCIO, "lunch"],
      [BORGHESE_GALLERY, "visit"],
    ]);
  });

  it("never takes a meal from a stop to put a restaurant back", () => {
    // Tuesday in Florence. Buca dell'Orafo is dinner; Rasputin after it runs past the day's end,
    // so it goes, and so does the Bargello, which comes too late. The Bargello goes back in the
    // morning. Rasputin would time cleanly just before Buca dell'Orafo, as dinner, but then Buca
    // dell'Orafo would be a visit at 20:50: a second dinner. So Rasputin stays out.
    const request = rome({ anchors: ["florence"] });
    const florence = (placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const day = [MERCATO_CENTRALE, UFFIZI, ACCADEMIA, BARGELLO, BUCA_DELL_ORAFO, RASPUTIN];
    const messy = answer(florence([PONTE_VECCHIO]), florence(day), florence([SANTA_CROCE]));

    const tidied = tidy(messy, request);

    // Day 0 has no dinner, so Rasputin moves there as one.
    expect(tidied.changes).toEqual([
      moved(1, RASPUTIN, 0, "does_not_fit"),
      { rule: "reordered", day: 1 },
    ]);
    const kept = idsOf(tidied.selection)[1] ?? [];
    expect(kept).toContain(BARGELLO);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    const dinner = made.itinerary.days[1]?.stops.find((stop) => stop.role === "dinner");
    expect(dinner?.placeId).toBe(BUCA_DELL_ORAFO);

    const before = kept.indexOf(BUCA_DELL_ORAFO);
    const swapped = [...kept.slice(0, before), RASPUTIN, ...kept.slice(before)];
    const other = answer(florence([PONTE_VECCHIO]), florence(swapped), florence([SANTA_CROCE]));
    const twice = materializeSelection(other, request, shortlistFor(request), ctx, META);
    expect(twice.errors).toEqual([]);
    const roles = twice.itinerary.days[1]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(roles?.slice(-2)).toEqual([
      [RASPUTIN, "dinner"],
      [BUCA_DELL_ORAFO, "visit"],
    ]);
  });

  it("does not put a place back where it only trades one error for another", () => {
    // Friday 26 February 2027 in Bologna. Dinner at Osteria Francescana, in Modena, ends too late
    // to get back to the base, which no drop mends. Piazza Maggiore by night after it would carry
    // that error instead: as many errors, but a new one, so the check keeps it out. (Only a
    // must-include is offered when it cannot fit even a day of its own at this pace.)
    const request = rome({
      anchors: ["bologna"],
      startDate: "2027-02-26",
      mustInclude: [OSTERIA_FRANCESCANA],
    });
    const bologna = (placeIds: string[]) => ({ anchorId: "bologna", placeIds });
    const day = [BALSAMIC_TASTING, OSTERIA_FRANCESCANA, PIAZZA_MAGGIORE_BY_NIGHT, VIA_DRAPPERIE];
    const messy = answer(bologna(day), bologna([TORRE_ASINELLI]), bologna([PINACOTECA]));

    const tidied = tidy(messy, request);

    // Kept out of day 0, the piazza by night moves to day 1, where it times cleanly.
    expect(tidied.changes).toContainEqual(moved(0, PIAZZA_MAGGIORE_BY_NIGHT, 1, "does_not_fit"));
    const codes = (selection: LlmSelection) =>
      errorsOf(selection, request).map((e) => [e.code, e.placeId]);
    expect(codes(tidied.selection)).toEqual([["OUTSIDE_DAY_WINDOW", OSTERIA_FRANCESCANA]]);
    const kept = idsOf(tidied.selection)[0] ?? [];
    const traded = answer(
      bologna([...kept, PIAZZA_MAGGIORE_BY_NIGHT]),
      bologna([TORRE_ASINELLI]),
      bologna([PINACOTECA]),
    );
    expect(codes(traded)).toEqual([["OUTSIDE_DAY_WINDOW", PIAZZA_MAGGIORE_BY_NIGHT]]);
  });

  it("puts a place back with a warning of its own, which came with the model's choice", () => {
    // Monday in Bologna. Before lunch in Parma, the balsamic tasting in Modena makes lunch too
    // late, and the lunch place is the day's only one, so the tasting goes. After lunch it fits.
    // Its hours are unknown, so the plan warns about it, as it would have with the model's order;
    // that warning is not a reason to leave it out.
    const request = rome({ anchors: ["bologna"] });
    const bologna = (placeIds: string[]) => ({ anchorId: "bologna", placeIds });
    const messy = answer(
      bologna([BALSAMIC_TASTING, PROSCIUTTO_DI_PARMA]),
      bologna([TORRE_ASINELLI]),
      bologna([PINACOTECA]),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 0 }]);
    expect(idsOf(tidied.selection)[0]).toEqual([PROSCIUTTO_DI_PARMA, BALSAMIC_TASTING]);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    const own = made.itinerary.warnings.filter((w) => w.placeId === BALSAMIC_TASTING);
    expect(own.map((w) => w.code)).toEqual(["HOURS_UNKNOWN"]);
  });

  it("lists exactly the places that left each day, after some go back or move", () => {
    // Day 0 loses the Vatican Museums and keeps Roscioli (above), day 1 keeps all three places of
    // the market day, and day 2 loses the Trevi Fountain by night (the same spot as the Trevi
    // Fountain on day 1) and its sixth visit. Neither of those goes back: a repeat never does, and
    // of the visit limit's drops only a meal place does. The museums and the sixth visit move to
    // day 1, which has room for both; the fountain by night stays out.
    const messy = answer(
      LOST_DINNER,
      [BORGHESE_GALLERY, TREVI_FOUNTAIN, MERCATO_TESTACCIO],
      [
        COLOSSEUM,
        TRASTEVERE,
        ROMAN_FORUM,
        GIANICOLO,
        AVENTINE_KEYHOLE,
        TREVI_BY_NIGHT,
        OSTERIA_FERNANDA,
        GIOLITTI,
      ],
    );

    const tidied = tidy(messy);

    const dropped = tidied.changes.filter((change) => change.rule !== "reordered");
    expect(dropped).toEqual([
      { rule: "same_spot", day: 2, placeId: TREVI_BY_NIGHT },
      moved(0, VATICAN_MUSEUMS, 1, "does_not_fit"),
      moved(2, GIOLITTI, 1, "over_visit_limit"),
    ]);
    expectDropsListed(messy, tidied);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("never puts back an ordinary visit dropped over the visit limit, even once a later drop makes room", () => {
    // A relaxed Wednesday holds three visits and the model chose four, so the last, the Aventine
    // Keyhole, goes. Then the Borghese Gallery cannot fit after the Vatican Museums and goes too,
    // which leaves room for a third visit. The Keyhole would time cleanly after the museums, but
    // it is not a meal place and it left for the limit, not the hours, so it does not go back:
    // it moves to day 0, and the gallery, closed on the Monday, to day 1.
    const request = rome({ pace: "relaxed" });
    const day = [COLOSSEUM, VATICAN_MUSEUMS, BORGHESE_GALLERY, AVENTINE_KEYHOLE];
    const messy = answer([PANTHEON], [OSTERIA_FERNANDA], day);

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      moved(2, AVENTINE_KEYHOLE, 0, "over_visit_limit"),
      moved(2, BORGHESE_GALLERY, 1, "does_not_fit"),
    ]);
    expect(idsOf(tidied.selection)[2]).toEqual([COLOSSEUM, VATICAN_MUSEUMS]);
    const back = [COLOSSEUM, VATICAN_MUSEUMS, AVENTINE_KEYHOLE];
    expect(errorsOf(answer([PANTHEON], [OSTERIA_FERNANDA], back), request)).toEqual([]);
  });

  it("puts back a restaurant the visit limit dropped as the lunch the day lacks", () => {
    // A recorded answer (the live evals of 2026-09-25, family-quiet, run 1 of one and run 3 of the
    // other). Sunday 6 June 2027, relaxed: three visits a day. In the model's order Il Sorpasso
    // comes after gelato, at 14:35, too late for lunch, so it is a fourth visit and the trim drops
    // it, and the day has no lunch. Before the gelato it is lunch, 13:50 to 15:20, which adds no
    // visit, so it goes back there.
    const request = rome({
      startDate: "2027-06-06",
      pace: "relaxed",
      interests: ["family-friendly", "outdoors", "quiet"],
      anchors: "auto",
    });
    const messy = answer(
      [GIANICOLO, BORGHESE_PARK, GIOLITTI, IL_SORPASSO, OSTERIA_FERNANDA],
      [MERCATO_TESTACCIO, ROMAN_FORUM, COLOSSEUM, DA_ENZO],
      [BORGHESE_GALLERY, TRASTEVERE, ROSCIOLI],
    );
    // The scheduler and the validator each report the fourth visit.
    const codes = errorsOf(messy, request).map((e) => [e.code, e.day]);
    expect(codes).toEqual([
      ["TOO_MANY_VISITS", 0],
      ["TOO_MANY_VISITS", 0],
    ]);

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 0 }]);
    expectDropsListed(messy, tidied);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    expect(made.itinerary.warnings.filter((w) => w.day === 0)).toEqual([]);
    const stops = made.itinerary.days[0]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(stops).toEqual([
      [GIANICOLO, "visit"],
      [BORGHESE_PARK, "visit"],
      [IL_SORPASSO, "lunch"],
      [GIOLITTI, "visit"],
      [OSTERIA_FERNANDA, "dinner"],
    ]);
  });

  it("puts back a restaurant the visit limit dropped as the dinner the day lacks", () => {
    // A recorded answer (splurge, run 2). Wednesday 19 May 2027: five visits, then Osteria
    // Fernanda after the Trevi Fountain by night, at 20:55, too late for a dinner before it
    // closes, so it is a sixth visit, the trim drops it, and the day has no dinner. Before the
    // fountain it is dinner, 19:40 to 21:20, and the fountain follows.
    const request = rome({
      startDate: "2027-05-19",
      interests: ["food", "scenic", "romantic"],
      maxPriceLevel: 4,
      anchors: "auto",
    });
    const day = [
      CAMPO_DE_FIORI,
      PIAZZA_NAVONA,
      ROSCIOLI,
      CASTEL_SANT_ANGELO,
      TRASTEVERE,
      TREVI_BY_NIGHT,
      OSTERIA_FERNANDA,
    ];
    const messy = answer(
      day,
      [GIANICOLO, PALATINE_HILL, MERCATO_TESTACCIO, AVENTINE_KEYHOLE, IL_SORPASSO],
      {
        anchorId: "florence",
        placeIds: [
          DUOMO_EXTERIOR,
          UFFIZI,
          PONTE_VECCHIO,
          PIAZZALE_MICHELANGELO,
          SAN_MINIATO,
          IL_LATINI,
        ],
      },
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 0 }]);
    expectDropsListed(messy, tidied);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    expect(made.itinerary.warnings.filter((w) => w.code === "MEAL_MISSING" && w.day === 0)).toEqual(
      [],
    );
    const last = made.itinerary.days[0]?.stops.slice(-2);
    expect(last?.map((stop) => [stop.placeId, stop.role, stop.start])).toEqual([
      [OSTERIA_FERNANDA, "dinner", 19 * 60 + 40],
      [TREVI_BY_NIGHT, "visit", 21 * 60 + 45],
    ]);
  });

  it("leaves out a restaurant the visit limit dropped when it cannot be the meal the day lacks", () => {
    // A recorded answer (must-include-two-cities, run 3). The last day moves to Florence and starts
    // with three hours in the Uffizi, a must-include, at 11:45. Il Latini is a sixth visit, so the
    // trim drops it, and the day has no lunch. But lunch before the Uffizi makes the day fail, and
    // after it lunch has passed: at no position is Il Latini lunch in a plan that passes.
    const request = rome({
      startDate: "2026-10-15",
      interests: ["art", "historic"],
      anchors: "auto",
      mustInclude: [BORGHESE_GALLERY, UFFIZI],
    });
    const florence = (placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const messy = answer(
      [
        BORGHESE_GALLERY,
        PANTHEON,
        PIAZZA_NAVONA,
        DA_ENZO,
        COLOSSEUM,
        ROMAN_FORUM,
        OSTERIA_FERNANDA,
      ],
      [VATICAN_MUSEUMS, CASTEL_SANT_ANGELO, TREVI_FOUNTAIN, ROSCIOLI, IL_SORPASSO],
      florence([
        UFFIZI,
        SANTA_CROCE,
        BARGELLO,
        BUCA_DELL_ORAFO,
        PONTE_VECCHIO,
        PIAZZALE_MICHELANGELO,
        IL_LATINI,
      ]),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes.filter((change) => change.day === 2)).toEqual([
      { rule: "over_visit_limit", day: 2, placeId: IL_LATINI },
      { rule: "does_not_fit", day: 2, placeId: BARGELLO },
    ]);
    expectDropsListed(messy, tidied);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    const missing = made.itinerary.warnings.filter((w) => w.code === "MEAL_MISSING" && w.day === 2);
    expect(missing.map((w) => w.detail)).toEqual(["Day 3 has no lunch stop."]);
    const kept = idsOf(tidied.selection)[2] ?? [];
    for (let at = 0; at <= kept.length; at++) {
      const placeIds = [...kept.slice(0, at), IL_LATINI, ...kept.slice(at)];
      const days = tidied.selection.days.map((d, index) => (index === 2 ? { ...d, placeIds } : d));
      const other = materializeSelection(
        { ...tidied.selection, days },
        request,
        shortlistFor(request),
        ctx,
        META,
      );
      const role = other.itinerary.days[2]?.stops.find((s) => s.placeId === IL_LATINI)?.role;
      expect(other.errors.length > 0 || role !== "lunch").toBe(true);
    }
  });

  it("never puts a restaurant back as an ordinary visit, even where it would fit as one", () => {
    // Wednesday. Il Sorpasso, then Roscioli, is lunch twice over in the model's order, and the
    // drop loop takes Il Sorpasso out. After lunch at Roscioli it would time cleanly as a visit,
    // 14:25 to 15:55, a second lunch; the day already has lunch and dinner, so it does not go
    // back. Day 0 has no lunch, so it moves there as one.
    const day = [COLOSSEUM, IL_SORPASSO, ROSCIOLI, OSTERIA_FERNANDA];
    const messy = answer([SPANISH_STEPS], [TRASTEVERE], day);
    expect(errorsOf(messy).length).toBeGreaterThan(0);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([moved(2, IL_SORPASSO, 0, "does_not_fit")]);
    expectDropsListed(messy, tidied);
    expect(idsOf(tidied.selection)[2]).toEqual([COLOSSEUM, ROSCIOLI, OSTERIA_FERNANDA]);
    expect(errorsOf(tidied.selection)).toEqual([]);
    const asVisit = answer(
      [SPANISH_STEPS],
      [TRASTEVERE],
      [COLOSSEUM, ROSCIOLI, IL_SORPASSO, OSTERIA_FERNANDA],
    );
    const made = materializeSelection(asVisit, rome(), shortlistFor(rome()), ctx, META);
    expect(made.errors).toEqual([]);
    const stop = made.itinerary.days[2]?.stops.find((s) => s.placeId === IL_SORPASSO);
    expect([stop?.role, stop?.start, stop?.end]).toEqual(["visit", 14 * 60 + 25, 15 * 60 + 55]);
  });

  it("never puts back a restaurant the visit limit dropped as a visit, even once a later drop makes room", () => {
    // Friday 2 July 2027, relaxed: three visits a day. In the model's order every place after the
    // Vatican Museums runs late, so the trim drops Roscioli, Il Sorpasso and Mercato Testaccio,
    // each timed as a visit, and then the Vatican Museums go for the hours, which leaves room for
    // a third visit. Mercato Testaccio goes back as the lunch the day lacks. Il Sorpasso would
    // time cleanly as that third visit before dinner, 16:45 to 18:15, but a restaurant goes back
    // only as a meal, so it does not go back. Roscioli and Il Sorpasso move to days 0 and 2 as
    // meals those days lack; the museums, closed on the Sunday and too long for the Saturday
    // before dinner there, stay out.
    const request = rome({
      startDate: "2027-07-01",
      pace: "relaxed",
      mustInclude: [BORGHESE_GALLERY, COLOSSEUM],
    });
    const day = [
      VATICAN_MUSEUMS,
      MERCATO_TESTACCIO,
      IL_SORPASSO,
      COLOSSEUM,
      OSTERIA_FERNANDA,
      BORGHESE_GALLERY,
      ROSCIOLI,
    ];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      moved(1, ROSCIOLI, 0, "over_visit_limit"),
      moved(1, IL_SORPASSO, 2, "over_visit_limit"),
      { rule: "does_not_fit", day: 1, placeId: VATICAN_MUSEUMS },
      { rule: "reordered", day: 1 },
    ]);
    expectDropsListed(messy, tidied);
    const made = materializeSelection(tidied.selection, request, shortlistFor(request), ctx, META);
    expect(made.errors).toEqual([]);
    const stops = made.itinerary.days[1]?.stops.map((stop) => [stop.placeId, stop.role]);
    expect(stops).toEqual([
      [COLOSSEUM, "visit"],
      [MERCATO_TESTACCIO, "lunch"],
      [BORGHESE_GALLERY, "visit"],
      [OSTERIA_FERNANDA, "dinner"],
    ]);
    const asVisit = [COLOSSEUM, MERCATO_TESTACCIO, BORGHESE_GALLERY, IL_SORPASSO, OSTERIA_FERNANDA];
    const other = materializeSelection(
      answer([SPANISH_STEPS], asVisit, [TRASTEVERE]),
      request,
      shortlistFor(request),
      ctx,
      META,
    );
    expect(other.errors).toEqual([]);
    const stop = other.itinerary.days[1]?.stops.find((s) => s.placeId === IL_SORPASSO);
    expect([stop?.role, stop?.start, stop?.end]).toEqual(["visit", 16 * 60 + 45, 18 * 60 + 15]);
  });

  it("counts a market that serves lunch as a restaurant: it goes back only as a meal", () => {
    // Wednesday. Mercato Testaccio, a market the reviewed list gives lunch, comes last and too late
    // in the model's order, so the drop loop takes it out. It would time cleanly as a morning
    // visit, 10:45 to 11:45, before the Vatican Museums. As lunch it would come first, at noon,
    // and push the Vatican Museums past closing. A meal place goes back only as a meal, so it
    // does not go back; it moves to day 0 as the lunch that day lacks.
    const day = [DA_ENZO, TREVI_FOUNTAIN, VATICAN_MUSEUMS, MERCATO_TESTACCIO];
    const messy = answer([SPANISH_STEPS], [TRASTEVERE], day);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([
      moved(2, MERCATO_TESTACCIO, 0, "does_not_fit"),
      { rule: "reordered", day: 2 },
    ]);
    expectDropsListed(messy, tidied);
    expect(idsOf(tidied.selection)[2]).toEqual([TREVI_FOUNTAIN, VATICAN_MUSEUMS, DA_ENZO]);
    expect(errorsOf(tidied.selection)).toEqual([]);
    const morning = [TREVI_FOUNTAIN, MERCATO_TESTACCIO, VATICAN_MUSEUMS, DA_ENZO];
    const made = materializeSelection(
      answer([SPANISH_STEPS], [TRASTEVERE], morning),
      rome(),
      shortlistFor(rome()),
      ctx,
      META,
    );
    expect(made.errors).toEqual([]);
    const stop = made.itinerary.days[2]?.stops.find((s) => s.placeId === MERCATO_TESTACCIO);
    expect([stop?.role, stop?.start, stop?.end]).toEqual(["visit", 10 * 60 + 45, 11 * 60 + 45]);
  });

  it("never lets a restaurant take the meal of a stop the day already has", () => {
    // Tuesday. Il Sorpasso after dinner at Roscioli is a sixth visit, so the trim drops it; the
    // Roman Forum then goes for the hours. Just before Roscioli, Il Sorpasso would time cleanly as
    // dinner at 19:00, but Roscioli would then be a visit at 20:55: a second dinner. As lunch, it
    // would push the Vatican Museums past closing. So it does not go back; it moves to day 0 as
    // the lunch that day lacks, and the Forum to day 2.
    const day = [
      BORGHESE_GALLERY,
      VATICAN_MUSEUMS,
      AVENTINE_KEYHOLE,
      PANTHEON,
      ROMAN_FORUM,
      ROSCIOLI,
      IL_SORPASSO,
    ];
    const messy = answer([SPANISH_STEPS], day, [TRASTEVERE]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([
      moved(1, IL_SORPASSO, 0, "over_visit_limit"),
      moved(1, ROMAN_FORUM, 2, "does_not_fit"),
    ]);
    expectDropsListed(messy, tidied);
    const kept = idsOf(tidied.selection)[1] ?? [];
    expect(kept).toEqual([BORGHESE_GALLERY, VATICAN_MUSEUMS, AVENTINE_KEYHOLE, PANTHEON, ROSCIOLI]);
    expect(errorsOf(tidied.selection)).toEqual([]);
    const before = kept.indexOf(ROSCIOLI);
    const stolen = [...kept.slice(0, before), IL_SORPASSO, ...kept.slice(before)];
    const other = materializeSelection(
      answer([SPANISH_STEPS], stolen, [TRASTEVERE]),
      rome(),
      shortlistFor(rome()),
      ctx,
      META,
    );
    expect(other.errors).toEqual([]);
    const roles = other.itinerary.days[1]?.stops.slice(-2).map((s) => [s.placeId, s.role]);
    expect(roles).toEqual([
      [IL_SORPASSO, "dinner"],
      [ROSCIOLI, "visit"],
    ]);
  });

  it("puts a place back only by inserting it, never by moving the day's other stops", () => {
    // Tuesday in Florence. The drop loop leaves San Miniato, lunch at Buca dell'Orafo, the Pitti
    // Palace and dinner, without the Uffizi and the Oltrarno. The Uffizi would fit as the first
    // stop with San Miniato moved to the afternoon, but at every position of the day as it is,
    // the check fails, so it does not go back and nothing in the day moves. The Uffizi move to
    // day 2 and the Oltrarno to day 0, which hold them.
    const request = rome({ anchors: ["florence"] });
    const florence = (placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const withDay = (placeIds: string[]) =>
      answer(florence([RASPUTIN]), florence(placeIds), florence([PALAZZO_VECCHIO]));
    const day = [SAN_MINIATO, BUCA_DELL_ORAFO, PITTI_PALACE, OLTRARNO, OSTERIA_ENOTECA, UFFIZI];

    const tidied = tidy(withDay(day), request);

    expect(tidied.changes).toEqual([
      moved(1, UFFIZI, 2, "does_not_fit"),
      moved(1, OLTRARNO, 0, "does_not_fit"),
    ]);
    const kept = idsOf(tidied.selection)[1] ?? [];
    expect(kept).toEqual([SAN_MINIATO, BUCA_DELL_ORAFO, PITTI_PALACE, OSTERIA_ENOTECA]);
    for (let at = 0; at <= kept.length; at++) {
      const inserted = [...kept.slice(0, at), UFFIZI, ...kept.slice(at)];
      expect(errorsOf(withDay(inserted), request).length).toBeGreaterThan(0);
    }
    const reordered = [UFFIZI, BUCA_DELL_ORAFO, SAN_MINIATO, PITTI_PALACE, OSTERIA_ENOTECA];
    expect(errorsOf(withDay(reordered), request)).toEqual([]);
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

  it("never changes a base or the input, and never adds a place the answer does not have", () => {
    const messy = answer(
      [BORGHESE_GALLERY, OSTERIA_FERNANDA, PANTHEON, TREVI_FOUNTAIN],
      [TREVI_BY_NIGHT, MERCATO_TESTACCIO, VATICAN_MUSEUMS, COLOSSEUM, PANTHEON],
      [DA_ENZO, ROMAN_FORUM, GIOLITTI],
    );
    const before = structuredClone(messy);

    const tidied = tidy(messy);

    expect(messy).toEqual(before);
    expect(tidied.changes.length).toBeGreaterThan(0);
    const answered = before.days.flatMap((day) => day.placeIds);
    tidied.selection.days.forEach((day, index) => {
      const original = before.days[index];
      expect(day.anchorId).toBe(original?.anchorId);
      for (const id of day.placeIds) expect(answered).toContain(id);
      // A place on another day than the model's is a move, and its reason came with it.
      const newcomers = day.placeIds.filter((id) => !original?.placeIds.includes(id));
      const movedIn = tidied.changes.filter((c) => c.rule === "moved_day" && c.toDay === index);
      expect(newcomers.sort()).toEqual(movedIn.map((c) => c.placeId).sort());
      expect(day.reasons).toEqual([
        ...(original?.reasons ?? []),
        ...newcomers.map((placeId) => ({ placeId, reason: "Fine." })),
      ]);
    });
    expect(tidied.changes.some((c) => c.rule === "moved_day")).toBe(true);
    expect(tidied.selection.summary).toBe(before.summary);
  });
});

describe("tidySelection across days", () => {
  // Friday 9 to Sunday 11 October 2026, Rome, balanced: the owner's request that fell back on
  // 2026-09-25 with EMPTY_DAY. This answer is rebuilt from its log: day 3 holds the Vatican
  // Museums (closed on Sundays) and three places days 1 and 2 already have.
  const OWNER = rome({ startDate: "2026-10-09" });
  const OWNER_ANSWER = answer(
    [
      BORGHESE_GALLERY,
      PANTHEON,
      GIOLITTI,
      DA_ENZO,
      TREVI_FOUNTAIN,
      SPANISH_STEPS,
      TRASTEVERE,
      IL_SORPASSO,
      OSTERIA_FERNANDA,
    ],
    [
      COLOSSEUM,
      ROMAN_FORUM,
      MERCATO_TESTACCIO,
      AVENTINE_KEYHOLE,
      GIANICOLO,
      ROSCIOLI,
      TREVI_BY_NIGHT,
    ],
    [VATICAN_MUSEUMS, GIANICOLO, SPANISH_STEPS, IL_SORPASSO],
  );

  it("keeps the owner's failed answer's Sunday: a repeat stays there and the day it came from loses it", () => {
    const tidied = tidy(OWNER_ANSWER, OWNER);

    expect(tidied.changes.filter((c) => c.rule !== "reordered")).toEqual([
      { rule: "closed", day: 2, placeId: VATICAN_MUSEUMS },
      { rule: "duplicate", day: 0, placeId: SPANISH_STEPS },
      { rule: "same_spot", day: 1, placeId: TREVI_BY_NIGHT },
      { rule: "duplicate", day: 2, placeId: GIANICOLO },
      { rule: "duplicate", day: 2, placeId: IL_SORPASSO },
      { rule: "over_visit_limit", day: 0, placeId: DA_ENZO },
    ]);
    expect(idsOf(tidied.selection)[2]).toEqual([SPANISH_STEPS]);
    expectDropsListed(OWNER_ANSWER, tidied);
    // Day 0 had the most stops to spare, and the Spanish Steps are a visit, not its lunch.
    expect(errorsOf(tidied.selection, OWNER)).toEqual([]);
  });

  it("never takes a place from a day that would then be empty, and the check reports the day", () => {
    const messy = answer([PANTHEON], [COLOSSEUM, ROMAN_FORUM], [PANTHEON]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "duplicate", day: 2, placeId: PANTHEON }]);
    expect(errorsOf(tidied.selection).map((e) => [e.code, e.day])).toEqual([["EMPTY_DAY", 2]]);
  });

  it("keeps a place at a repeated spot on the day it would empty, never against a must-include", () => {
    const messy = answer([TREVI_FOUNTAIN, PANTHEON], [COLOSSEUM], [TREVI_BY_NIGHT]);

    const plain = tidy(messy);
    expect(plain.changes).toEqual([{ rule: "same_spot", day: 0, placeId: TREVI_FOUNTAIN }]);
    expect(idsOf(plain.selection)[2]).toEqual([TREVI_BY_NIGHT]);
    expect(errorsOf(plain.selection)).toEqual([]);

    const request = rome({ mustInclude: [TREVI_FOUNTAIN] });
    const asked = tidy(messy, request);
    expect(asked.changes).toEqual([{ rule: "same_spot", day: 2, placeId: TREVI_BY_NIGHT }]);
    expect(errorsOf(asked.selection, request).map((e) => e.code)).toEqual(["EMPTY_DAY"]);
  });

  it("keeps a visit on a day the repeats would leave with meal places only, from a day with visits to spare", () => {
    // Day 2 repeats the Spanish Steps from day 0 between its lunch and its dinner. Dropped there,
    // it would leave day 2 two meals and no visit, so day 2 keeps it and day 0, with three other
    // visits, loses it.
    const messy = answer(
      [PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS, DA_ENZO, PIAZZA_NAVONA],
      [COLOSSEUM, ROMAN_FORUM, MERCATO_TESTACCIO, AVENTINE_KEYHOLE],
      [IL_SORPASSO, SPANISH_STEPS, OSTERIA_FERNANDA],
    );

    const tidied = tidy(messy);

    expect(tidied.changes.filter((c) => c.rule !== "reordered")).toEqual([
      { rule: "duplicate", day: 0, placeId: SPANISH_STEPS },
    ]);
    expect(idsOf(tidied.selection)[2]).toEqual([IL_SORPASSO, SPANISH_STEPS, OSTERIA_FERNANDA]);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("never takes a day's only visit to give one to a day of meal places", () => {
    // Day 0 has the Pantheon as its one visit, so day 2, which repeats it, stays with its meals.
    const messy = answer(
      [PANTHEON, DA_ENZO],
      [COLOSSEUM, ROMAN_FORUM, TREVI_FOUNTAIN],
      [IL_SORPASSO, PANTHEON, OSTERIA_FERNANDA],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "duplicate", day: 2, placeId: PANTHEON }]);
    expect(idsOf(tidied.selection)[0]).toEqual([PANTHEON, DA_ENZO]);
  });

  it("never keeps a repeated meal place on a day of meal places, since it gives the day no visit", () => {
    // Day 2 repeats Roscioli from day 0, which has four visits to spare. Kept there, it would
    // only take a meal from day 0 and leave day 2 with meal places alone all the same.
    const messy = answer(
      [PANTHEON, TREVI_FOUNTAIN, ROSCIOLI, SPANISH_STEPS, PIAZZA_NAVONA],
      [COLOSSEUM, ROMAN_FORUM, DA_ENZO],
      [IL_SORPASSO, ROSCIOLI, OSTERIA_FERNANDA],
    );

    const tidied = tidy(messy);

    expect(tidied.changes.filter((c) => c.rule !== "reordered")).toEqual([
      { rule: "duplicate", day: 2, placeId: ROSCIOLI },
    ]);
    expect(idsOf(tidied.selection)[0]).toContain(ROSCIOLI);
    expect(idsOf(tidied.selection)[2]).toEqual([IL_SORPASSO, OSTERIA_FERNANDA]);
  });

  it("keeps a visit rather than a meal place on a day the repeats would empty", () => {
    // Both of day 2's places repeat day 0, which has stops to spare either way. Roscioli comes
    // first, but the Pantheon is a visit, so the Pantheon stays and day 0 keeps Roscioli.
    const messy = answer(
      [PANTHEON, TREVI_FOUNTAIN, ROSCIOLI, SPANISH_STEPS, PIAZZA_NAVONA],
      [COLOSSEUM, ROMAN_FORUM, DA_ENZO],
      [ROSCIOLI, PANTHEON],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([
      { rule: "duplicate", day: 0, placeId: PANTHEON },
      { rule: "duplicate", day: 2, placeId: ROSCIOLI },
    ]);
    expect(idsOf(tidied.selection)[2]).toEqual([PANTHEON]);
    expect(idsOf(tidied.selection)[0]).toContain(ROSCIOLI);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("never keeps a place on two days: a second day cannot keep a repeat whose first copy gave way", () => {
    // Days 1 and 2 hold only the Pantheon, which day 0 has first. Day 1 keeps it and day 0 loses
    // it; the copy on day 2 repeats day 0's, which is gone, so day 2 cannot take it as well.
    const messy = answer([PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS], [PANTHEON], [PANTHEON]);

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([
      { rule: "duplicate", day: 0, placeId: PANTHEON },
      { rule: "duplicate", day: 2, placeId: PANTHEON },
    ]);
    expect(idsOf(tidied.selection)).toEqual([[TREVI_FOUNTAIN, SPANISH_STEPS], [PANTHEON], []]);
    expect(errorsOf(tidied.selection).map((e) => [e.code, e.day])).toEqual([["EMPTY_DAY", 2]]);
  });

  it("never keeps a place at a repeated spot when another place in the trip shares its spot", () => {
    // A chain of spots, made up for this test: the Spanish Steps share a spot with the Trevi
    // Fountain by night but not with the fountain by day. Day 2's fountain by night repeats the
    // fountain's spot on day 0; kept, it would stand at one spot with the Steps on day 1.
    const places = ctx.places.map((place) =>
      place.id === SPANISH_STEPS ? { ...place, sharedLocationWith: [TREVI_BY_NIGHT] } : place,
    );
    const chained = buildPlannerContext(places);
    const request = rome();
    const shortlist = buildShortlist(request, chained);
    const messy = answer([TREVI_FOUNTAIN, PANTHEON], [SPANISH_STEPS, COLOSSEUM], [TREVI_BY_NIGHT]);

    const tidied = tidySelection(messy, request, shortlist, chained);

    expect(tidied.changes).toEqual([{ rule: "same_spot", day: 2, placeId: TREVI_BY_NIGHT }]);
    expect(idsOf(tidied.selection)[2]).toEqual([]);
    // Without the chain, the fountain by night stays on day 2 (the test above).
    expect(idsOf(tidy(messy).selection)[2]).toEqual([TREVI_BY_NIGHT]);
  });

  it("moves a place from its closed day to a day at its base that is open for it", () => {
    // The Borghese Gallery is closed on Mondays, and the answer has it only on the Monday.
    const messy = answer(
      [BORGHESE_GALLERY, IL_SORPASSO, PANTHEON],
      [COLOSSEUM, DA_ENZO],
      [VATICAN_MUSEUMS, ROSCIOLI],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([moved(0, BORGHESE_GALLERY, 1, "closed")]);
    expect(idsOf(tidied.selection)[1]).toEqual([COLOSSEUM, DA_ENZO, BORGHESE_GALLERY]);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("moves a place to the day with the fewest stops first", () => {
    // Day 1 has six visits, one over the limit, so the Trastevere walk goes. Days 0 and 2 both
    // have room; day 2 has one stop.
    const messy = answer(
      [PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS],
      [COLOSSEUM, ROMAN_FORUM, GIOLITTI, AVENTINE_KEYHOLE, GIANICOLO, TRASTEVERE, DA_ENZO],
      [IL_SORPASSO],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([moved(1, TRASTEVERE, 2, "over_visit_limit")]);
    expectDropsListed(messy, tidied);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("moves a restaurant only as a meal another day lacks", () => {
    // Il Sorpasso is a second lunch on the Wednesday, so it goes for the hours. Days 0 and 1
    // have lunch and dinner already, so it stays out, though day 0 has room for a visit.
    const messy = answer(
      [PANTHEON, DA_ENZO, SPANISH_STEPS, EATALY],
      [MERCATO_TESTACCIO, ROMAN_FORUM, TREVI_FOUNTAIN, TRATTORIA_DA_CESARE],
      [COLOSSEUM, IL_SORPASSO, ROSCIOLI, OSTERIA_FERNANDA],
    );

    const tidied = tidy(messy);

    expect(tidied.changes).toEqual([{ rule: "does_not_fit", day: 2, placeId: IL_SORPASSO }]);
    expect(errorsOf(tidied.selection)).toEqual([]);
  });

  it("never moves a place to a day it cannot judge", () => {
    // Relaxed: day 1 drops its fourth visit and the Borghese Gallery. Day 0 holds an id that is
    // not a place, so nothing moves to it, and day 2 is full.
    const request = rome({ pace: "relaxed" });
    const messy = answer(
      ["place_999"],
      [COLOSSEUM, VATICAN_MUSEUMS, BORGHESE_GALLERY, AVENTINE_KEYHOLE],
      [ROMAN_FORUM, GIANICOLO, TRASTEVERE],
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      { rule: "over_visit_limit", day: 1, placeId: AVENTINE_KEYHOLE },
      { rule: "does_not_fit", day: 1, placeId: BORGHESE_GALLERY },
    ]);
    expect(idsOf(tidied.selection)[0]).toEqual(["place_999"]);
  });

  it("never moves a place the model was not offered", () => {
    // Budget €: the Borghese Gallery (€€) is not a candidate, and the answer has it on its closed
    // Monday. Moved to the Tuesday, it would be an id the check rejects, in a plan that passes
    // without it.
    const request = rome({ maxPriceLevel: 1 });
    const messy = answer(
      [BORGHESE_GALLERY, PANTHEON, TRASTEVERE, MERCATO_TESTACCIO],
      [PIAZZA_NAVONA, GIOLITTI, CAMPO_DE_FIORI],
      [TREVI_FOUNTAIN, SPANISH_STEPS, AVENTINE_KEYHOLE],
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes.filter((c) => c.rule !== "reordered")).toEqual([
      { rule: "closed", day: 0, placeId: BORGHESE_GALLERY },
    ]);
    expect(idsOf(tidied.selection).flat()).not.toContain(BORGHESE_GALLERY);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
  });

  it("never moves a place to a trip that has another place at its spot", () => {
    // Sunday 25 October in Florence: the Mercato Centrale is closed, and its food hall, at the
    // same spot, is day 1's lunch. Day 2 has room, but the market stays out.
    const request = rome({ startDate: "2026-10-25", anchors: ["florence"] });
    const florence = (...placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const messy = answer(
      florence(MERCATO_CENTRALE, PIAZZALE_MICHELANGELO, OLTRARNO),
      florence(ACCADEMIA, MERCATO_CENTRALE_FOOD_HALL, SANTA_CROCE, OSTERIA_ENOTECA),
      florence(UFFIZI),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toContainEqual({ rule: "closed", day: 0, placeId: MERCATO_CENTRALE });
    expect(idsOf(tidied.selection).flat()).not.toContain(MERCATO_CENTRALE);
    expectDropsListed(messy, tidied);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
  });

  it("moves a place to a day left empty, though the day then lacks lunch and dinner", () => {
    // Relaxed, from a Monday: day 0's only stop, the Borghese Gallery, is closed, and days 1 and 2
    // are full, so it stays out. Day 1's fourth visit goes for the limit and moves to the empty
    // Monday, which then only warns of its missing meals, where the empty day was an error.
    const request = rome({ pace: "relaxed" });
    const messy = answer(
      [BORGHESE_GALLERY],
      [COLOSSEUM, ROMAN_FORUM, PANTHEON, TREVI_FOUNTAIN],
      [GIANICOLO, TRASTEVERE, AVENTINE_KEYHOLE],
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      { rule: "closed", day: 0, placeId: BORGHESE_GALLERY },
      moved(1, TREVI_FOUNTAIN, 0, "over_visit_limit"),
    ]);
    expect(idsOf(tidied.selection)[0]).toEqual([TREVI_FOUNTAIN]);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
  });

  it("drops the repeat record of a place that moves to the day that repeated it", () => {
    // Relaxed: the Aventine Keyhole is day 0's fourth visit and a repeat on day 2. Day 0's copy
    // goes for the limit, day 2's as a repeat, and then the first moves to day 2: the place ends
    // up where the model also put it, and neither day lists it as left.
    const request = rome({ pace: "relaxed" });
    const messy = answer(
      [PANTHEON, TREVI_FOUNTAIN, SPANISH_STEPS, AVENTINE_KEYHOLE],
      [COLOSSEUM, ROMAN_FORUM, GIANICOLO],
      [TRASTEVERE, AVENTINE_KEYHOLE],
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([moved(0, AVENTINE_KEYHOLE, 2, "over_visit_limit")]);
    expect(idsOf(tidied.selection)[2]).toEqual([TRASTEVERE, AVENTINE_KEYHOLE]);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
  });

  it("drops the same-spot record of a place that moves to the day that had it", () => {
    // Sunday 25 October in Florence, packed, at the lowest budget: the market is closed on day 0,
    // and day 1's copy gives way to the food hall at its spot. The food hall, over the budget, is
    // a visit on day 0 and leaves, so the market moves to day 1, where the model also put it.
    const request = rome({
      startDate: "2026-10-25",
      pace: "packed",
      maxPriceLevel: 1,
      anchors: ["florence"],
    });
    const florence = (...placeIds: string[]) => ({ anchorId: "florence", placeIds });
    const messy = answer(
      florence(BARGELLO, MERCATO_CENTRALE_FOOD_HALL, MERCATO_CENTRALE),
      florence(MERCATO_CENTRALE, SANTA_CROCE),
      florence(SAN_MINIATO),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      moved(0, MERCATO_CENTRALE, 1, "closed"),
      { rule: "over_budget_visit", day: 0, placeId: MERCATO_CENTRALE_FOOD_HALL },
    ]);
    expect(idsOf(tidied.selection)[1]).toContain(MERCATO_CENTRALE);
    expect(errorsOf(tidied.selection, request)).toEqual([]);
  });
});

describe("tidySelection and meal places", () => {
  /** Each stop of the tidied plan as [place, role], day by day, with the check's errors. */
  function timed(selection: LlmSelection, request: TripRequest) {
    const made = materializeSelection(selection, request, shortlistFor(request), ctx, META);
    const roles = made.itinerary.days.map((day) => day.stops.map((s) => [s.placeId, s.role]));
    return { errors: made.errors, roles, warnings: made.itinerary.warnings };
  }

  /** The stops the check warns are over the budget, with their roles. */
  function overBudget(selection: LlmSelection, request: TripRequest) {
    const { roles, warnings } = timed(selection, request);
    return warnings
      .filter((w) => w.code === "OVER_BUDGET")
      .map((w) => roles[w.day ?? -1]?.find(([placeId]) => placeId === w.placeId));
  }

  // Sunday 22 November 2026, Florence, packed, food and markets, at the lowest budget: a live
  // answer of prover 4 (2026-09-25, prompt v3), run 2. Buca dell'Orafo is one level over the
  // budget, offered for meals only; the model put it after dinner at Rasputin.
  const FOOD_MARKETS = rome({
    startDate: "2026-11-22",
    pace: "packed",
    interests: ["food", "market"],
    maxPriceLevel: 1,
    anchors: ["florence"],
  });
  const florence = (...placeIds: string[]) => ({ anchorId: "florence", placeIds });
  const FOOD_MARKETS_ANSWER = answer(
    florence(
      DUOMO_EXTERIOR,
      BARGELLO,
      SANTA_CROCE,
      BUCA_DELL_ORAFO,
      PONTE_VECCHIO,
      PIAZZALE_MICHELANGELO,
      RASPUTIN,
    ),
    florence(MERCATO_CENTRALE, SAN_MINIATO, MERCATO_CENTRALE_FOOD_HALL),
    florence(IL_LATINI, PIENZA_DAY_TRIP),
  );

  it("seats a restaurant over the budget as the lunch its day lacks, never as a visit", () => {
    // Tidied at 030ec00, Buca dell'Orafo was a 20:50 visit after dinner and the day had no lunch.
    // The nearest order that makes it lunch takes it and the Bargello before the Piazzale.
    const tidied = tidy(FOOD_MARKETS_ANSWER, FOOD_MARKETS);

    const { errors, roles } = timed(tidied.selection, FOOD_MARKETS);
    expect(errors).toEqual([]);
    expect(roles[0]).toEqual([
      [DUOMO_EXTERIOR, "visit"],
      [PONTE_VECCHIO, "visit"],
      [BARGELLO, "visit"],
      [BUCA_DELL_ORAFO, "lunch"],
      [PIAZZALE_MICHELANGELO, "visit"],
      [SANTA_CROCE, "visit"],
      [RASPUTIN, "dinner"],
    ]);
    expect(tidied.changes).toContainEqual({ rule: "reordered", day: 0 });
    expect(overBudget(tidied.selection, FOOD_MARKETS).every((stop) => stop?.[1] !== "visit")).toBe(
      true,
    );
    expectDropsListed(FOOD_MARKETS_ANSWER, tidied);
  });

  // Friday 9 to Sunday 11 October 2026, Rome, balanced, at the lowest budget: the reviewer's
  // probe of 2026-09-25. Il Sorpasso, one level over the budget, comes between the Trevi Fountain
  // and dinner at Trattoria da Cesare, at 16:30, and lunch is already Da Enzo's.
  const BUDGET = rome({ startDate: "2026-10-09", maxPriceLevel: 1 });
  const BUDGET_DAY = [
    GIOLITTI,
    DA_ENZO,
    PANTHEON,
    TREVI_FOUNTAIN,
    IL_SORPASSO,
    TRATTORIA_DA_CESARE,
  ];

  it("moves a restaurant over the budget that its day can only time as a visit to a day that lacks the meal", () => {
    const messy = answer(
      BUDGET_DAY,
      [TREVI_BY_NIGHT, SPANISH_STEPS, TRASTEVERE],
      [GIANICOLO, AVENTINE_KEYHOLE, CAMPO_DE_FIORI],
    );

    const tidied = tidy(messy, BUDGET);

    expect(tidied.changes).toEqual([
      { rule: "same_spot", day: 1, placeId: TREVI_BY_NIGHT },
      moved(0, IL_SORPASSO, 1, "over_budget_visit"),
    ]);
    const { errors, roles } = timed(tidied.selection, BUDGET);
    expect(errors).toEqual([]);
    expect(roles[1]).toEqual([
      [SPANISH_STEPS, "visit"],
      [TRASTEVERE, "visit"],
      [IL_SORPASSO, "lunch"],
    ]);
    expect(overBudget(tidied.selection, BUDGET).every((stop) => stop?.[1] !== "visit")).toBe(true);
  });

  // Tuesday 20 October 2026, Rome then Florence, at the lowest budget. Every day has its lunch
  // and dinner, and day 0 also has Il Sorpasso, over the budget, as a morning visit before lunch.
  const FULL = rome({ startDate: "2026-10-20", maxPriceLevel: 1, anchors: ["rome", "florence"] });
  const FULL_ANSWER = answer(
    [GIOLITTI, IL_SORPASSO, DA_ENZO, PANTHEON, TREVI_FOUNTAIN, TRATTORIA_DA_CESARE],
    [MERCATO_TESTACCIO, TRASTEVERE, SPANISH_STEPS, EATALY],
    florence(DUOMO_EXTERIOR, BUCA_DELL_ORAFO, SANTA_CROCE, PONTE_VECCHIO, RASPUTIN),
  );

  it("drops a restaurant over the budget that no day at its base can have as a meal", () => {
    const tidied = tidy(FULL_ANSWER, FULL);

    expect(tidied.changes).toEqual([{ rule: "over_budget_visit", day: 0, placeId: IL_SORPASSO }]);
    expect(idsOf(tidied.selection)[0]).toEqual([
      GIOLITTI,
      DA_ENZO,
      PANTHEON,
      TREVI_FOUNTAIN,
      TRATTORIA_DA_CESARE,
    ]);
    const { errors } = timed(tidied.selection, FULL);
    expect(errors).toEqual([]);
    expect(overBudget(tidied.selection, FULL).every((stop) => stop?.[1] !== "visit")).toBe(true);
  });

  it("keeps a restaurant over the budget as a visit when the traveler asked for it", () => {
    const asked = { ...FULL, mustInclude: [IL_SORPASSO] };

    const tidied = tidy(FULL_ANSWER, asked);

    expect(tidied.changes).toEqual([]);
    expect(timed(tidied.selection, asked).roles[0]?.[1]).toEqual([IL_SORPASSO, "visit"]);
  });

  it("drops a second restaurant over the budget that the first one's drop leaves as a visit", () => {
    // Monday 19 October, Rome then Florence, packed, at the lowest budget. Il Sorpasso is a
    // morning visit that brings Eataly to lunch; without it, Eataly arrives at 10:10, too early
    // for lunch, and is a visit too. Rome has no other day, so both stay out.
    const request = rome({ pace: "packed", maxPriceLevel: 1, anchors: ["rome", "florence"] });
    const messy = answer(
      [CAMPO_DE_FIORI, IL_SORPASSO, EATALY],
      florence(SANTA_CROCE, IL_LATINI, PONTE_VECCHIO, PIAZZALE_MICHELANGELO, SAN_MINIATO, RASPUTIN),
      florence(MERCATO_CENTRALE_FOOD_HALL, DUOMO_EXTERIOR),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes).toEqual([
      { rule: "over_budget_visit", day: 0, placeId: IL_SORPASSO },
      { rule: "over_budget_visit", day: 0, placeId: EATALY },
    ]);
    expect(idsOf(tidied.selection)[0]).toEqual([CAMPO_DE_FIORI]);
    expect(timed(tidied.selection, request).errors).toEqual([]);
    expect(overBudget(tidied.selection, request).every((stop) => stop?.[1] !== "visit")).toBe(true);
  });

  // Tuesday 20 October 2026, Florence, balanced. The Mercato Centrale's market (a visit) and its
  // food hall (a meal place for lunch and dinner) are one spot, so only one of them may stay.
  const MARKET = rome({ startDate: "2026-10-20", anchors: ["florence"] });

  it("keeps the food hall rather than the market at its spot when its day needs the lunch", () => {
    // Day 0 has dinner at the Osteria dell'Enoteca and no other lunch place.
    const messy = answer(
      florence(MERCATO_CENTRALE, SAN_MINIATO, MERCATO_CENTRALE_FOOD_HALL, OSTERIA_ENOTECA),
      florence(UFFIZI, BUCA_MARIO, ACCADEMIA, IL_LATINI),
      florence(SANTA_CROCE, BUCA_DELL_ORAFO, PONTE_VECCHIO, RASPUTIN),
    );

    const tidied = tidy(messy, MARKET);

    expect(tidied.changes).toEqual([{ rule: "same_spot", day: 0, placeId: MERCATO_CENTRALE }]);
    const { errors, roles } = timed(tidied.selection, MARKET);
    expect(errors).toEqual([]);
    expect(roles[0]).toEqual([
      [SAN_MINIATO, "visit"],
      [MERCATO_CENTRALE_FOOD_HALL, "lunch"],
      [OSTERIA_ENOTECA, "dinner"],
    ]);
  });

  it("keeps the food hall on a later day that needs its lunch, and the day with the market loses it", () => {
    const messy = answer(
      florence(MERCATO_CENTRALE, UFFIZI, BUCA_DELL_ORAFO, ACCADEMIA, IL_LATINI),
      florence(MERCATO_CENTRALE_FOOD_HALL, SAN_MINIATO, SANTA_CROCE, OSTERIA_ENOTECA),
      florence(BARGELLO, BUCA_MARIO, PONTE_VECCHIO, RASPUTIN),
    );

    const tidied = tidy(messy, MARKET);

    expect(tidied.changes).toEqual([{ rule: "same_spot", day: 0, placeId: MERCATO_CENTRALE }]);
    const { errors, roles } = timed(tidied.selection, MARKET);
    expect(errors).toEqual([]);
    expect(roles[1]?.[0]).toEqual([MERCATO_CENTRALE_FOOD_HALL, "lunch"]);
  });

  it("keeps the market, the first at the spot, when the food hall's day has its lunch and dinner", () => {
    // Day 1 has lunch at Buca Mario and dinner at the Osteria dell'Enoteca, so the food hall would
    // be a visit there. Day 0's hours cannot hold the market as well, so it moves to day 2.
    const messy = answer(
      florence(MERCATO_CENTRALE, UFFIZI, BUCA_DELL_ORAFO, ACCADEMIA, IL_LATINI),
      florence(BUCA_MARIO, SAN_MINIATO, MERCATO_CENTRALE_FOOD_HALL, SANTA_CROCE, OSTERIA_ENOTECA),
      florence(BARGELLO, PONTE_VECCHIO, RASPUTIN),
    );

    const tidied = tidy(messy, MARKET);

    expect(tidied.changes).toEqual([
      { rule: "same_spot", day: 1, placeId: MERCATO_CENTRALE_FOOD_HALL },
      moved(0, MERCATO_CENTRALE, 2, "does_not_fit"),
    ]);
    expect(errorsOf(tidied.selection, MARKET)).toEqual([]);
  });

  it("keeps a market the traveler asked for, even on a day the food hall would give lunch", () => {
    const asked = { ...MARKET, mustInclude: [MERCATO_CENTRALE] };
    const messy = answer(
      florence(MERCATO_CENTRALE, SAN_MINIATO, MERCATO_CENTRALE_FOOD_HALL, OSTERIA_ENOTECA),
      florence(UFFIZI, BUCA_MARIO, ACCADEMIA, IL_LATINI),
      florence(SANTA_CROCE, BUCA_DELL_ORAFO, PONTE_VECCHIO, RASPUTIN),
    );

    const tidied = tidy(messy, asked);

    expect(tidied.changes).toEqual([
      { rule: "same_spot", day: 0, placeId: MERCATO_CENTRALE_FOOD_HALL },
    ]);
  });

  it("keeps the food hall at the market's spot when the trip then has more meals, as live", () => {
    // The live answer above: day 1 holds the market, San Miniato and the food hall, and no other
    // meal place. At 030ec00 the market stayed, the first at the spot, and the day had no meal.
    const tidied = tidy(FOOD_MARKETS_ANSWER, FOOD_MARKETS);

    expect(tidied.changes).toContainEqual({ rule: "same_spot", day: 1, placeId: MERCATO_CENTRALE });
    expect(timed(tidied.selection, FOOD_MARKETS).roles[1]).toEqual([
      [MERCATO_CENTRALE_FOOD_HALL, "lunch"],
      [SAN_MINIATO, "visit"],
    ]);
  });

  it("swaps two restaurants in the wrong order, so the one that serves lunch is lunch", () => {
    // Wednesday 21 October in Florence, packed: a live day of prover 4 on another Wednesday. Buca
    // Mario is dinner and Rasputin, which serves only dinner, a visit after it at 21:05. The
    // nearest order with lunch takes the Boboli Gardens and Buca Mario before the Pitti Palace,
    // and Rasputin is dinner.
    const packed = { ...MARKET, pace: "packed" as const };
    const day = [SAN_MINIATO, PITTI_PALACE, BOBOLI_GARDENS, BUCA_MARIO, RASPUTIN];
    const messy = answer(
      florence(UFFIZI, BUCA_DELL_ORAFO, ACCADEMIA, IL_LATINI),
      florence(...day),
      florence(BARGELLO, SANTA_CROCE, MERCATO_CENTRALE_FOOD_HALL, OSTERIA_ENOTECA),
    );

    const tidied = tidy(messy, packed);

    expect(tidied.changes).toEqual([{ rule: "reordered", day: 1 }]);
    const { errors, roles } = timed(tidied.selection, packed);
    expect(errors).toEqual([]);
    expect(roles[1]).toEqual([
      [SAN_MINIATO, "visit"],
      [BOBOLI_GARDENS, "visit"],
      [BUCA_MARIO, "lunch"],
      [PITTI_PALACE, "visit"],
      [RASPUTIN, "dinner"],
    ]);
  });

  it("moves a visit out of lunch's way when a restaurant can only be lunch in another order", () => {
    // Thursday 12 November 2026 in Venice, a live day of prover 4: in the model's order the Doge's
    // Palace and the Guggenheim fill the day to 17:35, and the Osteria Alla Staffa is a visit at
    // 17:55. Seated for lunch after St. Mark's, the Guggenheim must come before the Doge's Palace
    // to fit its 18:00 closing: three swapped pairs, the fewest that give the day its lunch.
    const request = rome({ startDate: "2026-11-12", anchors: ["venice"] });
    const venice = (...placeIds: string[]) => ({ anchorId: "venice", placeIds });
    const day = [
      RIALTO_BRIDGE,
      ST_MARKS_BASILICA,
      DOGES_PALACE,
      GUGGENHEIM,
      OSTERIA_ALLA_STAFFA,
      OSTERIA_DA_RIOBA,
    ];
    const messy = answer(
      venice(...day),
      venice(SAN_GIORGIO_CAMPANILE, AL_QUADRI),
      venice(DORSODURO, CICCHETTI_CRAWL),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes.filter((c) => c.day === 0)).toEqual([{ rule: "reordered", day: 0 }]);
    expect(idsOf(tidied.selection)[0]).toEqual([
      RIALTO_BRIDGE,
      ST_MARKS_BASILICA,
      OSTERIA_ALLA_STAFFA,
      GUGGENHEIM,
      DOGES_PALACE,
      OSTERIA_DA_RIOBA,
    ]);
    const { errors, roles } = timed(tidied.selection, request);
    expect(errors).toEqual([]);
    expect(roles[0]?.filter(([, role]) => role !== "visit")).toEqual([
      [OSTERIA_ALLA_STAFFA, "lunch"],
      [OSTERIA_DA_RIOBA, "dinner"],
    ]);
  });

  it("leaves a day in its order when no order of its own stops gives it the meal", () => {
    // Sunday 15 November 2026 in Florence, packed: day 1 of a live repair answer of prover 3, in
    // the order tidying gave it. Buca Mario is dinner and Rasputin a visit after it, and no order
    // of the seven stops times with a lunch within the visit limit, so the day keeps its order.
    const request = rome({
      startDate: "2026-11-15",
      pace: "packed",
      anchors: ["florence", "bologna"],
    });
    const day = [
      PIAZZALE_MICHELANGELO,
      SAN_MINIATO,
      BARGELLO,
      BOBOLI_GARDENS,
      PITTI_PALACE,
      BUCA_MARIO,
      RASPUTIN,
    ];
    const messy = answer(
      florence(...day),
      florence(MERCATO_CENTRALE, SANTA_CROCE),
      florence(UFFIZI, ACCADEMIA, DUOMO_EXTERIOR, PONTE_VECCHIO, BUCA_DELL_ORAFO, OSTERIA_ENOTECA),
    );

    const tidied = tidy(messy, request);

    expect(tidied.changes.filter((c) => c.day === 0)).toEqual([]);
    expect(idsOf(tidied.selection)[0]).toEqual(day);
    expect(timed(tidied.selection, request).roles[0]?.at(-1)).toEqual([RASPUTIN, "visit"]);
    const anchor = ctx.anchorById.get("florence");
    if (!anchor) throw new Error("no Florence base");
    const orders = (ids: string[]): string[][] =>
      ids.length <= 1
        ? [ids]
        : ids.flatMap((id, at) =>
            orders([...ids.slice(0, at), ...ids.slice(at + 1)]).map((rest) => [id, ...rest]),
          );
    const lunches = orders(day).filter((order) => {
      const timedDay = scheduleDay(order, request.startDate, anchor, request, ctx, 0);
      const clean = timedDay.violations.every((v) => v.severity !== "error");
      const visits = timedDay.stops.filter((stop) => stop.role === "visit").length;
      return clean && visits <= 6 && timedDay.stops.some((stop) => stop.role === "lunch");
    });
    expect(lunches).toEqual([]);
  });
});
