import { readFileSync } from "node:fs";
import type { PlanRow } from "./sweepMetrics";

// The sweep's summary (summarize), its table (printTable), the comparison of saved runs
// (compare), and the place-level comparison (movedShares): what `sweep.ts` and `sweepPlaces.ts`
// print and what docs/planner.md quotes.

/** Plans with fewer visits than this on some day count as starved (every pace allows 3). */
const STARVED_BELOW = 2;

/** The sweep's headline numbers over a set of rows. Shares are percentages. */
export function summarize(rows: readonly PlanRow[]): Record<string, number> {
  const ok = rows.filter((row) => row.failed === undefined);
  const days = ok.flatMap((row) => row.visits ?? []);
  const sum = (pick: (row: PlanRow) => number) => ok.reduce((total, row) => total + pick(row), 0);
  const share = (part: number, whole: number) => (whole === 0 ? 0 : (100 * part) / whole);
  const trips = (test: (row: PlanRow) => boolean) => share(ok.filter(test).length, ok.length);
  const perDay = (index: number) =>
    ok.reduce((total, row) => total + (row.visits?.[index] ?? 0), 0) / Math.max(1, ok.length);
  const chosen = ok.filter((row) => row.segments.includes("chosen"));
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  return {
    plans: rows.length,
    failures: rows.length - ok.length,
    validatorErrors: sum((row) => row.errors?.length ?? 0),
    starvedTrips: trips((row) => (row.visits ?? []).some((v) => v < STARVED_BELOW)),
    visitsDay1: perDay(0),
    visitsDay2: perDay(1),
    visitsDay3: perDay(2),
    visitsPerDay: days.reduce((a, b) => a + b, 0) / Math.max(1, days.length),
    mealMissingDays: share(
      sum((row) => row.mealMissingDays ?? 0),
      days.length,
    ),
    meallessDays: share(
      sum((row) => row.mealless ?? 0),
      days.length,
    ),
    lunchMissingDays: share(
      sum((row) => row.lunchMissing ?? 0),
      days.length,
    ),
    dinnerMissingDays: share(
      sum((row) => row.dinnerMissing ?? 0),
      days.length,
    ),
    twoBaseTrips: trips((row) => (row.bases ?? 0) >= 2),
    longTransferTrips: trips((row) => row.longTransfer === true),
    preferenceMatch: share(
      sum((r) => r.interestMatches ?? 0),
      sum((r) => r.interestStops ?? 0),
    ),
    travelPerDay:
      sum((row) => (row.travelMin ?? []).reduce((a, b) => a + b, 0)) / Math.max(1, days.length),
    waitPerDay:
      sum((row) => (row.waitMin ?? []).reduce((a, b) => a + b, 0)) / Math.max(1, days.length),
    longWaitDays: share(
      sum((row) => row.longWaits ?? 0),
      days.length,
    ),
    lateStops: share(
      sum((row) => row.lateStops ?? 0),
      sum((row) => row.stops ?? 0),
    ),
    mustPlaced: share(
      sum((row) => row.mustPlaced ?? 0),
      sum((row) => row.mustWanted ?? 0),
    ),
    mustMistimed: share(
      sum((row) => row.mustMistimed ?? 0),
      sum((row) => row.mustPlaced ?? 0),
    ),
    iconicPerTrip: sum((row) => row.iconic ?? 0) / Math.max(1, ok.length),
    notChosenTrips: share(chosen.filter((row) => row.notChosen).length, chosen.length),
    ruleBreakTrips: trips((row) => (row.ruleBreaks ?? 0) > 0),
    townBreakTrips: trips((row) => (row.townBreaks ?? 0) > 0),
    mealPlaceVisitTrips: trips((row) => (row.mealVisits ?? 0) > 0),
    overBudgetStops: share(
      sum((row) => row.overBudget ?? 0),
      sum((row) => row.stops ?? 0),
    ),
    msP50: times[Math.floor(times.length * 0.5)] ?? 0,
    msP95: times[Math.floor(times.length * 0.95)] ?? 0,
  };
}

/** Row labels for the table, in the order a reader should see them. */
const LABELS: Record<string, string> = {
  failures: "planner threw",
  validatorErrors: "validator errors",
  starvedTrips: "trips with a starved day (%)",
  visitsDay1: "visits on day 1",
  visitsDay2: "visits on day 2",
  visitsDay3: "visits on day 3",
  visitsPerDay: "visits per day",
  mealMissingDays: "days missing lunch or dinner (%)",
  lunchMissingDays: "days missing lunch (%)",
  dinnerMissingDays: "days missing dinner (%)",
  meallessDays: "days with no meal at all (%)",
  twoBaseTrips: "trips with 2 bases (%)",
  longTransferTrips: "trips with a transfer over 3 h (%)",
  preferenceMatch: "visits matching an interest (%)",
  travelPerDay: "travel minutes per day",
  waitPerDay: "daytime waiting minutes per day",
  longWaitDays: "days with a daytime wait over 60 min (%)",
  lateStops: "stops starting after 22:00 (%)",
  mustPlaced: "must-includes placed (%)",
  mustMistimed: "placed must-includes timed against a day rule (%)",
  iconicPerTrip: "iconic sights per trip",
  notChosenTrips: "chosen-base trips using another base (%)",
  ruleBreakTrips: "trips breaking a day rule (%)",
  townBreakTrips: "trips with a disjointed trip out of town (%)",
  mealPlaceVisitTrips: "trips with a meal place planned as a sight (%)",
  overBudgetStops: "stops over budget (%)",
  msP50: "ms per plan, p50",
  msP95: "ms per plan, p95",
};

export function printTable(
  names: readonly string[],
  columns: readonly Record<string, number>[],
): void {
  const base = columns[0] ?? {};
  const cell = (value: number, index: number, key: string) => {
    const text = value.toFixed(Number.isInteger(value) ? 0 : 2);
    if (index === 0 || key.startsWith("ms")) return text;
    const delta = value - (base[key] ?? 0);
    return Math.abs(delta) < 0.005 ? "=" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`;
  };
  const header = ["metric", ...names];
  const body = Object.entries(LABELS).map(([key, label]) => [
    label,
    ...columns.map((column, index) => cell(column[key] ?? 0, index, key)),
  ]);
  const widths = header.map((_, c) =>
    Math.max(...[header, ...body].map((row) => row[c]?.length ?? 0)),
  );
  for (const row of [header, ...body]) {
    console.log(row.map((text, c) => text.padEnd(widths[c] ?? 0)).join("  "));
  }
}

/** A saved run, as `sweep.ts --out` writes it. */
export interface SweepResult {
  label: string;
  seed: number;
  profile: string;
  bySegment: Record<string, Record<string, number>>;
  rows: PlanRow[];
}

/**
 * Why two saved runs cannot be compared request by request, or null when they can: the same
 * seed, profile, and number of plans.
 */
// Decision: refuse instead of warn. compare() pairs rows by index, so runs of different requests
// printed confident deltas (a thin run against a mixed one: "starved trips +60").
export function mismatch(first: SweepResult, other: SweepResult): string | null {
  for (const key of ["seed", "profile"] as const) {
    if (first[key] !== other[key]) {
      return `${other.label} has ${key} ${other[key]}, ${first.label} has ${first[key]}`;
    }
  }
  if (first.rows.length !== other.rows.length) {
    return `${other.label} has ${other.rows.length} plans, ${first.label} has ${first.rows.length}`;
  }
  return null;
}

/** Deltas of each result against the first, for one segment (SEGMENT, default "all"). */
export function compare(files: readonly string[]): void {
  const segment = process.env.SEGMENT ?? "all";
  const results = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as SweepResult);
  const first = results[0];
  if (!first) return;
  for (const result of results.slice(1)) {
    const reason = mismatch(first, result);
    if (reason) throw new Error(`Cannot compare: ${reason}. Rerun with the same flags.`);
  }
  const columns = results.map((result) => result.bySegment[segment] ?? {});
  printTable(
    results.map((result) => result.label),
    columns,
  );
  for (const result of results.slice(1)) {
    const changed = result.rows.filter(
      (row, n) => row.fingerprint !== first.rows[n]?.fingerprint,
    ).length;
    console.log(
      `${result.label}: ${changed} of ${result.rows.length} plans differ from ${first.label}`,
    );
  }
}

// Decision: 20 points. A pace is a third of the place-level weekday check (sweepPlaces.ts), so a
// sight lost at one pace moves its share by 33 points and is listed; restaurants trading places
// move less than that.
export const MIN_POINTS = 20;

/** Counts per key: [times seen, times counted]; a share is seen / counted. */
export type Shares = Record<string, [number, number]>;

/**
 * Every key whose share moved by at least `minPoints` percentage points, as [points, key], the
 * largest first. `worse` says which direction is worse: fewer sightings, or more.
 */
export function movedShares(
  before: Shares,
  after: Shares,
  worse: "fewer" | "more",
  minPoints = MIN_POINTS,
): [number, string][] {
  const moved: [number, string][] = [];
  for (const [key, [seen, counted]] of Object.entries(before)) {
    const [seenAfter, countedAfter] = after[key] ?? [0, 0];
    if (counted === 0 || countedAfter === 0) continue;
    const change = (100 * seenAfter) / countedAfter - (100 * seen) / counted;
    const points = worse === "fewer" ? -change : change;
    if (Math.abs(points) >= minPoints) moved.push([Math.round(points), key]);
  }
  return moved.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}
