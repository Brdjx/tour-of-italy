import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PlannerContext } from "../src/context";
import { addDays, weekdayOf } from "../src/time";
import type { Itinerary, Pace, TripRequest } from "../src/types";
import { movedShares, type Shares } from "./sweepReport";

// The sweep's place-level check. The sweep (sweep.ts) judges averages over whole profiles, and
// an average can hide a sight that drops out of every trip of one kind. This plans two fixed
// sets of requests and records, per place:
//   weekday: in plain trips at one chosen base, started on each weekday of a year, how often the
//     place is in the plan (by base and start weekday);
//   must: with the place as the only must-include, how often the day that holds it has no lunch,
//     and no dinner.
// Compare two runs to list every share that moved by MIN_POINTS (sweepReport.ts) or more, worse
// first.
//
//   pnpm exec tsx packages/planner/scripts/sweepPlaces.ts --out DIR --label before
//   pnpm exec tsx packages/planner/scripts/sweepPlaces.ts --src COPY/src --out DIR --label after
//   pnpm exec tsx packages/planner/scripts/sweepPlaces.ts --compare DIR/before.json DIR/after.json

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "../../../data/italy.json");
const PACES: readonly Pace[] = ["relaxed", "balanced", "packed"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Start dates: every day of one year for the weekday check, 104 spread dates for the must one. */
const YEAR_FROM = "2026-03-01";
const MUST_STARTS = 104;
interface PlacesResult {
  label: string;
  weekday: Shares; // "base Sun place_010": in the plan
  must: Shares; // "place_052 no dinner": the must-include's day without that meal
}

function plainRequest(startDate: string, pace: Pace, anchors: TripRequest["anchors"]): TripRequest {
  return {
    startDate,
    pace,
    interests: [],
    maxPriceLevel: null,
    anchors,
    mustInclude: [],
    exclude: [],
  };
}

function count(shares: Shares, key: string, seen: boolean): void {
  const entry = shares[key] ?? [0, 0];
  entry[0] += seen ? 1 : 0;
  entry[1] += 1;
  shares[key] = entry;
}

type Plan = (request: TripRequest) => Itinerary;

function weekdayShares(plan: Plan, ctx: PlannerContext): Shares {
  const shares: Shares = {};
  for (const anchor of ctx.anchors) {
    for (let day = 0; day < 364; day++) {
      const startDate = addDays(YEAR_FROM, day);
      const weekday = WEEKDAYS[weekdayOf(startDate)] ?? "";
      for (const pace of PACES) {
        const planned = plan(plainRequest(startDate, pace, [anchor.id])).days.flatMap((d) =>
          d.stops.map((stop) => stop.placeId),
        );
        for (const id of anchor.placeIds) {
          // Meal places trade places with each other; the check is about sights.
          if (ctx.placesById.get(id)?.mealCapable) continue;
          count(shares, `${anchor.id} ${weekday} ${id}`, planned.includes(id));
        }
      }
    }
  }
  return shares;
}

function mustShares(plan: Plan, ctx: PlannerContext): Shares {
  const shares: Shares = {};
  for (const place of ctx.places) {
    for (let n = 0; n < MUST_STARTS; n++) {
      const startDate = addDays("2026-01-02", n * 7 + (n % 7)); // every weekday, all year
      const request = plainRequest(startDate, PACES[n % 3] as Pace, "auto");
      const itinerary = plan({ ...request, mustInclude: [place.id] });
      const day = itinerary.days.find((d) => d.stops.some((s) => s.placeId === place.id));
      if (!day) continue;
      for (const meal of ["lunch", "dinner"] as const) {
        count(shares, `${place.id} no ${meal}`, !day.stops.some((stop) => stop.role === meal));
      }
    }
  }
  return shares;
}

async function run(src: string, label: string, out: string): Promise<void> {
  const planner = await import(pathToFileURL(join(src, "index.ts")).href);
  const raw: unknown = JSON.parse(readFileSync(DATA, "utf8"));
  const ctx = planner.buildPlannerContext(planner.buildDataset(raw).places) as PlannerContext;
  const plan: Plan = (request) => planner.planDeterministic(request, ctx);
  const result: PlacesResult = {
    label,
    weekday: weekdayShares(plan, ctx),
    must: mustShares(plan, ctx),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.json`), `${JSON.stringify(result)}\n`);
  console.log(`wrote ${join(out, `${label}.json`)}`);
}

function compareFiles(first: string, second: string): void {
  const [a, b] = [first, second].map((f) => JSON.parse(readFileSync(f, "utf8")) as PlacesResult);
  if (!a || !b) return;
  console.log(`weekday: sights in plain trips, points (+ is worse for ${b.label})`);
  for (const [points, key] of movedShares(a.weekday, b.weekday, "fewer")) console.log(points, key);
  console.log("must: the must-include's day without a meal, points (+ is worse)");
  for (const [points, key] of movedShares(a.must, b.must, "more")) console.log(points, key);
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};
const compareAt = argv.indexOf("--compare");
try {
  if (compareAt !== -1) compareFiles(argv[compareAt + 1] ?? "", argv[compareAt + 2] ?? "");
  else {
    const out = flag("--out");
    if (!out) throw new Error("--out DIR is required: a run is only useful to compare");
    const src = resolve(flag("--src") ?? join(HERE, "../src"));
    await run(src, flag("--label") ?? "baseline", resolve(out));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
