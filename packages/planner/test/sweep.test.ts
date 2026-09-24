import { describe, expect, it } from "vitest";
import { measurePlan, townBreak, waits } from "../scripts/sweepMetrics";
import {
  mismatch,
  movedShares,
  type Shares,
  type SweepResult,
  summarize,
} from "../scripts/sweepReport";
import { coverage, sweepRequests } from "../scripts/sweepRequests";
import { TRAVEL } from "../src/config";
import { planDeterministic } from "../src/plan";
import { TripRequestSchema } from "../src/schemas";
import type { DayPlan, Stop } from "../src/types";
import { makeRequest, realContext } from "./plannerFixtures";

// The sweep (scripts/sweep.ts) is how every planner rule earned its place (docs/planner.md).
// The failures these tests prevent: two runs that plan different requests and so cannot be
// compared, a sweep that silently skips the hard calendar cases, a metric that miscounts, and a
// sight lost from one kind of trip hidden behind a steady average (sweepPlaces.ts).

const ctx = realContext();

describe("the sweep's requests", () => {
  it("never changes for a given seed, so two runs compare request by request", () => {
    expect(sweepRequests(ctx, 50, 7)).toEqual(sweepRequests(ctx, 50, 7));
    expect(sweepRequests(ctx, 50, 7)).not.toEqual(sweepRequests(ctx, 50, 8));
    expect(sweepRequests(ctx, 50, 7, "thin")).toEqual(sweepRequests(ctx, 50, 7, "thin"));
  });

  it.each(["mixed", "thin", "must", "holiday"] as const)(
    "never sends the planner a request the API would reject (%s)",
    (profile) => {
      for (const request of sweepRequests(ctx, 200, 20260924, profile)) {
        expect(TripRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
        expect(request.mustInclude.filter((id) => request.exclude.includes(id))).toEqual([]);
      }
    },
  );

  it("never skips Mondays, Sundays, January, August, or public holidays", () => {
    const covered = coverage(sweepRequests(ctx, 3000, 20260924));
    for (const [name, count] of Object.entries(covered)) {
      expect(count, name).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("the sweep's metrics", () => {
  const itinerary = planDeterministic(
    makeRequest({ startDate: "2026-10-20", anchors: ["rome"] }),
    ctx,
  );

  it("counts a plan's visits per day and finds no validator error in a planner plan", () => {
    const row = measurePlan(itinerary, ctx);
    expect(row.errors).toEqual([]);
    expect(row.visits).toEqual(
      itinerary.days.map((day) => day.stops.filter((s) => s.role === "visit").length),
    );
    expect(row.bases).toBe(1);
  });

  it("never misses a dinner taken out of a day, or a day left with one visit", () => {
    const day = itinerary.days[0];
    if (!day) throw new Error("no day");
    const withoutDinner = day.stops.filter((stop) => stop.role !== "dinner");
    const firstVisit = withoutDinner.findIndex((stop) => stop.role === "visit");
    const oneVisit = withoutDinner.filter((stop, at) => stop.role !== "visit" || at === firstVisit);
    const changed = {
      ...itinerary,
      days: [{ ...day, stops: oneVisit }, ...itinerary.days.slice(1)],
    };
    const before = measurePlan(itinerary, ctx);
    const after = measurePlan(changed, ctx);
    expect(after.dinnerMissing).toBe((before.dinnerMissing ?? 0) + 1);
    const rows = [{ n: 0, segments: ["all"], ms: 1, ...after }];
    expect(summarize(rows).starvedTrips).toBe(100);
  });
});

/** A stop at `start` (hh:mm) lasting `minutes`, reached after `travel` minutes. */
function stop(placeId: string, start: string, minutes: number, travel = 20, role = "visit"): Stop {
  const [hours, mins] = start.split(":").map(Number);
  const begin = (hours ?? 0) * 60 + (mins ?? 0);
  return { placeId, start: begin, end: begin + minutes, travelFromPrevMin: travel, role } as Stop;
}

function dayAt(anchorId: string, stops: Stop[]): DayPlan {
  return { date: "2026-10-20", anchorId, transferMin: 0, stops };
}

// Places: 026 Uffizi, 027 Piazzale Michelangelo, 029 Buca Mario, 033 Buca dell'Orafo, 037
// Aperitivo at Rasputin (Florence); 038 Siena and 089 Pienza day trips (Florence's base); 043
// Osteria Francescana, 044 and 083 Modena tastings, 045 Ferrari Museum in Maranello, 048 Asinelli
// tower (Bologna's base); 085 Como lakefront, 30 minutes long (Milan's base).
describe("the sweep's waiting and out-of-town metrics", () => {
  const request = makeRequest({ anchors: "auto" });

  it("never counts the first stop, dinner, or an evening stop as daytime waiting", () => {
    const uffizi = stop("place_026", "09:30", 180);
    const lunch = stop("place_029", "13:20", 90, 15, "lunch"); // ready at 12:55: 25 min idle
    const evening = stop("place_037", "18:30", 90);
    const dinner = stop("place_033", "20:30", 90, 15, "dinner");
    expect(TRAVEL.bufferMin).toBe(10);
    expect(waits([uffizi, lunch, evening, dinner])).toEqual([25]);
  });

  it("never flags a plain day trip out of town, or two stops in one town", () => {
    const siena = dayAt("florence", [stop("place_038", "10:30", 360, 70)]);
    expect(townBreak(siena, request, ctx)).toBe(false);
    const modena = [stop("place_044", "10:00", 90, 50), stop("place_083", "11:40", 90, 10)];
    expect(townBreak(dayAt("bologna", modena), request, ctx)).toBe(false);
  });

  const breaks: [string, DayPlan][] = [
    [
      "leaves town twice",
      dayAt("bologna", [
        stop("place_044", "09:30", 90, 50),
        stop("place_048", "12:00", 45, 50),
        stop("place_045", "13:40", 150, 55),
      ]),
    ],
    [
      "joins two towns 39 km apart",
      dayAt("florence", [stop("place_038", "09:30", 300, 70), stop("place_089", "15:10", 60, 60)]),
    ],
    [
      "leaves after 15:00",
      dayAt("florence", [stop("place_026", "09:30", 360), stop("place_038", "16:30", 120, 70)]),
    ],
    ["goes for less time than the journey", dayAt("milan", [stop("place_085", "10:30", 30, 60)])],
    [
      "starts the trip out with a meal",
      dayAt("bologna", [stop("place_043", "12:30", 120, 50, "lunch")]),
    ],
  ];
  it.each(breaks)("flags a day that %s", (_, day) => {
    expect(townBreak(day, request, ctx)).toBe(true);
  });

  it("never flags a trip out the traveler asked for", () => {
    const late = dayAt("florence", [
      stop("place_026", "09:30", 360),
      stop("place_038", "16:30", 120, 70),
    ]);
    const asked = makeRequest({ anchors: ["florence"], mustInclude: ["place_038"] });
    expect(townBreak(late, asked, ctx)).toBe(false);
  });
});

describe("comparing saved runs", () => {
  const run = (label: string, seed: number, profile: string, plans: number): SweepResult => ({
    label,
    seed,
    profile,
    bySegment: {},
    rows: Array.from({ length: plans }, (_, n) => ({ n, segments: ["all"], ms: 1 })),
  });

  it("never pairs runs of different requests row by row", () => {
    const base = run("before", 20260924, "mixed", 3000);
    expect(mismatch(base, run("after", 20260924, "mixed", 3000))).toBeNull();
    expect(mismatch(base, run("after", 11, "mixed", 3000))).toMatch(/seed 11/);
    expect(mismatch(base, run("after", 20260924, "thin", 3000))).toMatch(/profile thin/);
    expect(mismatch(base, run("after", 20260924, "mixed", 1000))).toMatch(/1000 plans/);
  });
});

describe("the place-level check", () => {
  it("never hides a sight that dropped out of one kind of trip behind a steady average", () => {
    // The Vatican in every Rome trip starting on a Sunday, then in none; the Monday share steady.
    const before: Shares = { "rome Sun place_010": [30, 30], "rome Mon place_010": [30, 30] };
    const after: Shares = { "rome Sun place_010": [0, 30], "rome Mon place_010": [29, 30] };
    expect(movedShares(before, after, "fewer")).toEqual([[100, "rome Sun place_010"]]);
  });

  it("reads more as worse for a missing meal, and lists gains as negative points", () => {
    const before: Shares = { "place_052 no dinner": [0, 50] };
    const after: Shares = { "place_052 no dinner": [15, 50] };
    expect(movedShares(before, after, "more")).toEqual([[30, "place_052 no dinner"]]);
    expect(movedShares(after, before, "more")).toEqual([[-30, "place_052 no dinner"]]);
    expect(movedShares(before, after, "more", 31)).toEqual([]);
  });
});
