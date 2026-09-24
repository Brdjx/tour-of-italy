import { describe, expect, it } from "vitest";
import { transferMinutes } from "../src/anchors";
import * as planner from "../src/index";
import { chooseWarnings, cleanSelection, compareViolations, planWarnings } from "../src/plan";
import { scheduleDay } from "../src/schedule";
import { attachReasons, scheduleTrip, withoutErrorStops } from "../src/trip";
import type { DayPlan, Itinerary } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeViolation } from "../src/violations";
import { makeRequest, realContext } from "./plannerFixtures";

// scheduleTrip turns ids per day into a timed trip: it is the last step of the planner and the
// step the AI path and shared links need. Wrong transfers, dates, or a lost reason would show the
// traveler an impossible or unexplained day.

const ctx = realContext();
const MONDAY = "2026-10-19";

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

describe("withoutErrorStops (last line of defense)", () => {
  const time = (ids: readonly string[]) =>
    scheduleDay(ids, MONDAY, base("rome"), makeRequest({ startDate: MONDAY }), ctx, 0);

  it("drops a place that is closed that day and keeps the rest in order", () => {
    expect(withoutErrorStops(["place_005", "place_007", "place_008"], time)).toEqual([
      "place_005",
      "place_008",
    ]);
  });

  it("returns a clean day unchanged, and ends on a day-level error it cannot fix", () => {
    expect(withoutErrorStops(["place_005", "place_008"], time)).toEqual(["place_005", "place_008"]);
    expect(withoutErrorStops([], time)).toEqual([]);
  });
});

describe("cleanSelection (defensive step of planDeterministic)", () => {
  it("removes a stop scheduleDay rejects and keeps a clean draft exactly as it was", () => {
    const request = makeRequest({ startDate: MONDAY });
    const draft = {
      anchorIds: ["rome", "rome", "rome"],
      days: [["place_005", "place_007"], ["place_004"], ["place_016"]],
      score: 0,
    };
    const cleaned = cleanSelection(draft, request, ctx);
    expect(cleaned.map((day) => day.placeIds)).toEqual([
      ["place_005"],
      ["place_004"],
      ["place_016"],
    ]);
    const clean = { ...draft, days: [["place_005"], ["place_004"], ["place_016"]] };
    expect(cleanSelection(clean, request, ctx).map((day) => day.placeIds)).toEqual(clean.days);
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
    "withoutErrorStops",
    "NoFeasiblePlanError",
  ])("exports %s as a function, so the API and web app never get undefined", (name) => {
    expect(typeof exported.get(name)).toBe("function");
  });

  it("never drops the scheduler tunables the web app displays", () => {
    expect(planner.MAX_IDLE_MIN).toBe(30);
    expect(planner.MEAL_WAIT_MAX_MIN).toBe(60);
    expect(planner.ANCHOR_SHORTLIST).toBe(3);
  });
});
