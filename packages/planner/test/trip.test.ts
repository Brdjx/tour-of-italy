import { describe, expect, it } from "vitest";
import { moveStop, removeStop, rescheduleDay } from "../src/alternatives";
import { transferMinutes } from "../src/anchors";
import * as planner from "../src/index";
import { chooseWarnings, compareViolations, planDeterministic, planWarnings } from "../src/plan";
import { attachReasons, scheduleTrip } from "../src/trip";
import type { DayPlan, Itinerary } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeViolation } from "../src/violations";
import { makeRequest, realContext } from "./plannerFixtures";

// scheduleTrip turns ids per day into a timed trip: it is the last step of the planner and the
// step the AI path and shared links need. Wrong transfers, dates, or a lost reason would show the
// traveler an impossible or unexplained day.

const ctx = realContext();

function base(id: string) {
  const anchor = ctx.anchorById.get(id);
  if (!anchor) throw new Error(`no base ${id}`);
  return anchor;
}

describe("scheduleTrip", () => {
  const request = makeRequest({ startDate: "2026-10-20" });

  it("dates day i as startDate plus i and charges a transfer only when the base changes", () => {
    const trip = scheduleTrip(
      request,
      [
        { anchorId: "rome", placeIds: ["place_001"] },
        { anchorId: "florence", placeIds: ["place_026"] },
        { anchorId: "florence", placeIds: ["place_032"] },
      ],
      ctx,
    );
    expect(trip.days.map((day) => day.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    const toFlorence = transferMinutes(base("rome"), base("florence"));
    expect(trip.days.map((day) => day.transferMin)).toEqual([0, toFlorence, 0]);
    expect(trip.days[1]?.stops[0]?.start).toBeGreaterThanOrEqual(570 + toFlorence);
  });

  it("gives an unknown base an empty day and UNKNOWN_ANCHOR, and measures the next transfer from the last real base", () => {
    const trip = scheduleTrip(
      request,
      [
        { anchorId: "rome", placeIds: ["place_001"] },
        { anchorId: "atlantis", placeIds: ["place_026"] },
        { anchorId: "florence", placeIds: ["place_032"] },
      ],
      ctx,
    );
    expect(trip.violations.find((v) => v.code === "UNKNOWN_ANCHOR")).toMatchObject({ day: 1 });
    expect(trip.days[1]?.stops).toEqual([]);
    expect(trip.days[2]?.transferMin).toBe(transferMinutes(base("rome"), base("florence")));
  });

  it("writes a rule reason for every stop and keeps an AI reason for the same place and role", () => {
    const previous: DayPlan[] = [
      {
        date: "2026-10-20",
        anchorId: "rome",
        transferMin: 0,
        stops: [
          {
            placeId: "place_001",
            start: 0,
            end: 1,
            travelFromPrevMin: 0,
            role: "visit",
            reason: "AI.",
            reasonSource: "ai",
          },
        ],
      },
    ];
    const trip = scheduleTrip(
      request,
      [{ anchorId: "rome", placeIds: ["place_001", "place_005"] }],
      ctx,
      previous,
    );
    expect(trip.days[0]?.stops.map((s) => [s.reasonSource, s.reason])).toEqual([
      ["ai", "AI."],
      ["rule", expect.any(String)],
    ]);
  });
});

describe("attachReasons", () => {
  it("never drops an AI reason onto a stop whose role changed (a lunch reason on a visit)", () => {
    const stop = {
      placeId: "place_003",
      start: 1170,
      end: 1260,
      travelFromPrevMin: 0,
      role: "dinner" as const,
    };
    const old = {
      ...stop,
      role: "lunch" as const,
      reason: "Great lunch.",
      reasonSource: "ai" as const,
    };
    const [result] = attachReasons([stop], makeRequest(), ctx, [old]);
    expect(result?.reasonSource).toBe("rule");
    expect(result?.reason).not.toBe("Great lunch.");
  });

  it("says what the stop's date means only when it is given the trip", () => {
    const parma = {
      placeId: "place_053", // the Parma tour, weekdays only, six hours
      start: 705,
      end: 1065,
      travelFromPrevMin: 0,
      role: "visit" as const,
    };
    const days = ["2026-10-09", "2026-10-10", "2026-10-11"].map((date) => ({
      date,
      anchorId: "bologna",
    }));
    const [dated] = attachReasons([parma], makeRequest(), ctx, [], { days, index: 0 });
    expect(dated?.reason).toContain("The only day of this trip it can be visited.");
    const [undated] = attachReasons([parma], makeRequest(), ctx);
    // Without the trip only what holds on any date: the day has no lunch stop, and the visit is
    // an outing under way through lunch.
    expect(undated?.reason).toBe(
      "Listed as a local favorite. Rated 4.7 out of 5. Lunch is part of this outing.",
    );
  });

  it("keeps the date sentences on a day retimed after an edit", () => {
    const market = "place_024"; // the Fontanella Borghese book market, shut on Sundays
    const plan = planDeterministic(makeRequest({ startDate: "2026-10-09" }), ctx);
    const index = plan.days.findIndex((day) => day.stops.some((s) => s.placeId === market));
    expect(plan.days[index]?.date).toBe("2026-10-10"); // a Saturday, the day before a Sunday
    const ids = plan.days[index]?.stops.map((stop) => stop.placeId) ?? [];
    const edited = rescheduleDay(plan, index, ids, ctx).itinerary;
    const stop = edited.days[index]?.stops.find((s) => s.placeId === market);
    expect(stop?.reason).toContain("It cannot be visited on Sunday, the trip's last day.");
  });

  describe("an AI reason carried through an edit", () => {
    // Friday 9 October 2026 in Rome: the Pantheon from 09:35, the Borghese Gallery from 10:50,
    // lunch at Roscioli, the Roman Forum, the Aventine Keyhole, and Pigneto from 18:20.
    const plan = planDeterministic(makeRequest({ startDate: "2026-10-09" }), ctx);
    const PANTHEON = "place_005";
    const BORGHESE = "place_007";
    const AI_REASONS: Record<string, string> = {
      [PANTHEON]: "An ancient temple to start the day.",
      [BORGHESE]: "Bernini's sculptures in a villa's rooms.",
    };
    const withAi: Itinerary = {
      ...plan,
      days: plan.days.map((day, index) =>
        index !== 0
          ? day
          : {
              ...day,
              stops: day.stops.map((stop) => {
                const reason = AI_REASONS[stop.placeId];
                return reason === undefined ? stop : { ...stop, reason, reasonSource: "ai" };
              }),
            },
      ),
    };

    function edited(ids: string[]) {
      const day = rescheduleDay(withAi, 0, ids, ctx).itinerary.days[0];
      return (placeId: string) => day?.stops.find((stop) => stop.placeId === placeId);
    }

    it("gives way to the rule reason when a move makes it untrue: no longer the day's start", () => {
      const day = withAi.days[0] as DayPlan;
      expect(day.stops.map((stop) => stop.placeId).slice(0, 2)).toEqual([PANTHEON, BORGHESE]);
      const stopOf = edited(moveStop(day, 0, 2));
      const pantheon = stopOf(PANTHEON);
      expect(stopOf(BORGHESE)?.start).toBeLessThan(pantheon?.start ?? 0);
      expect(pantheon?.role).toBe("visit");
      expect(pantheon?.reasonSource).toBe("rule");
      expect(pantheon?.reason).not.toBe(AI_REASONS[PANTHEON]);
    });

    it("keeps a reason that is still true after the edit, and one left where it was", () => {
      const day = withAi.days[0] as DayPlan;
      // The Borghese Gallery moves to the day's start: its reason names no time or place in the day.
      const moved = edited(moveStop(day, 1, 0));
      expect(moved(BORGHESE)).toMatchObject({ reason: AI_REASONS[BORGHESE], reasonSource: "ai" });
      // Removing the Aventine Keyhole re-times the afternoon; the Pantheon still starts the day.
      const aventine = day.stops.findIndex((stop) => stop.placeId === "place_014");
      const removed = edited(removeStop(day, aventine));
      expect(removed(PANTHEON)).toMatchObject({ reason: AI_REASONS[PANTHEON], reasonSource: "ai" });
    });
  });

  it("carries no AI reason without the trip, which the check needs to place the stop", () => {
    const stop = {
      placeId: "place_005",
      start: 575,
      end: 620,
      travelFromPrevMin: 0,
      role: "visit" as const,
    };
    const old = { ...stop, reason: "A Roman temple.", reasonSource: "ai" as const };
    const days = [{ date: "2026-10-09", anchorId: "rome" }];
    expect(attachReasons([stop], makeRequest(), ctx, [old], { days, index: 0 })[0]).toMatchObject({
      reason: "A Roman temple.",
      reasonSource: "ai",
    });
    expect(attachReasons([stop], makeRequest(), ctx, [old])[0]?.reasonSource).toBe("rule");
  });

  it("leaves an unknown place without a reason rather than inventing one", () => {
    const stop = {
      placeId: "place_999",
      start: 600,
      end: 660,
      travelFromPrevMin: 0,
      role: "visit" as const,
    };
    expect(attachReasons([stop], makeRequest(), ctx)[0]).toEqual(stop);
  });
});

describe("warning selection and order", () => {
  const own = [makeViolation("HOURS_UNKNOWN", "own", { day: 0, placeId: "place_021" })];
  const must = [makeViolation("MUST_INCLUDE_UNPLACEABLE", "why", { placeId: "place_064" })];

  it("never shows the traveler a warning list other than the validator's, errors left out", () => {
    const request = makeRequest({ startDate: "2026-10-20", mustInclude: ["place_064"] });
    const trip = scheduleTrip(request, [{ anchorId: "rome", placeIds: ["place_021"] }], ctx);
    const meta = { attempts: 0, latencyMs: 0, generatedAt: "1970-01-01T00:00:00.000Z" };
    const itinerary: Itinerary = {
      request,
      days: trip.days,
      source: "deterministic",
      warnings: [],
      meta,
    };
    const fromValidator = validateItinerary(itinerary, ctx);
    const shown = planWarnings(itinerary, ctx);
    expect(fromValidator.some((v) => v.severity === "error")).toBe(true); // one day, not three
    expect(shown).toEqual(
      fromValidator.filter((v) => v.severity === "warning").sort(compareViolations),
    );
  });

  it("keeps the deprecated chooseWarnings working for callers of the old API", () => {
    expect(chooseWarnings(own, must, []).map((v) => v.detail)).toEqual(["why", "own"]);
  });

  it("switches to the validator's warnings, drops its errors, and never duplicates a must-include reason", () => {
    const validator = [
      makeViolation("MEAL_MISSING", "validator", { day: 1 }),
      makeViolation("OVERLAP", "an error", { day: 1 }),
      makeViolation("MUST_INCLUDE_UNPLACEABLE", "validator why", { placeId: "place_064" }),
    ];
    const chosen = chooseWarnings(own, must, validator);
    expect(chosen.map((v) => v.detail)).toEqual(["validator why", "validator"]);
    expect(chosen.every((v) => v.severity === "warning")).toBe(true);
  });

  it("orders trip-level warnings first, then by day and stop, so the list never reshuffles", () => {
    const list = [
      makeViolation("MEAL_MISSING", "b", { day: 2 }),
      makeViolation("HOURS_UNKNOWN", "a", { day: 0, stopIndex: 3 }),
      makeViolation("MUST_INCLUDE_UNPLACEABLE", "c", { placeId: "x" }),
      makeViolation("HOURS_UNKNOWN", "d", { day: 0, stopIndex: 1 }),
    ];
    expect([...list].sort(compareViolations).map((v) => v.detail)).toEqual(["c", "d", "a", "b"]);
  });
});

describe("package entry point", () => {
  const exported = new Map<string, unknown>(Object.entries(planner));

  it.each([
    "scheduleDay",
    "scheduleTrip",
    "attachReasons",
    "planDeterministic",
    "alternativesFor",
    "removeStop",
    "moveStop",
    "replaceStop",
    "rescheduleDay",
    "inferRole",
    "timeStep",
    "startCursor",
    "advanceCursor",
    "chooseWarnings",
    "planWarnings",
    "compareViolations",
    "NoFeasiblePlanError",
  ])("exports %s as a function, so the API and web app never get undefined", (name) => {
    expect(typeof exported.get(name)).toBe("function");
  });
});
