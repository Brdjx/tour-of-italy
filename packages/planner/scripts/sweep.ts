import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlannerContext, type PlannerContext } from "../src/context";
import { buildDataset } from "../src/normalize/index";
import { tripDates } from "../src/time";
import type { Itinerary, TripRequest } from "../src/types";
import { measurePlan, type PlanRow, segmentsOf } from "./sweepMetrics";
import { compare, printTable, summarize } from "./sweepReport";
import { coverage, PROFILES, type Profile, sweepRequests } from "./sweepRequests";

// The planner's measurement harness. It plans a fixed, seeded set of requests and prints what a
// traveler would notice: validator errors, starved days, missing meals, bases and transfers,
// interest matches, travel and waiting, late stops, and runtime. It is how every rule in the
// planner earned its place (docs/planner.md): run it against a copy of src with one rule taken
// out and compare.
//
//   pnpm exec tsx packages/planner/scripts/sweep.ts                  # 3000 plans, table only
//   pnpm exec tsx packages/planner/scripts/sweep.ts --out DIR --label baseline
//   pnpm exec tsx packages/planner/scripts/sweep.ts --profile thin --count 1000  # must, holiday
//   pnpm exec tsx packages/planner/scripts/sweep.ts --src COPY/src --out DIR --label no-route
//   pnpm exec tsx packages/planner/scripts/sweep.ts --compare DIR/baseline.json DIR/no-route.json
//
// A copy outside the repository needs a node_modules link next to its src so zod resolves.
// Decision: the bar a rule must clear to stay. Removing it must make a metric worse by at least
// 2 points on a share, 0.1 visits a day, 10 minutes of travel or waiting a day, or 0.2 iconic
// sights a trip, on a whole profile, or cause a validator error or a planner failure.

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "../../../data/italy.json");

interface Args {
  src: string;
  label: string;
  count: number;
  seed: number;
  profile: Profile;
  out: string | null;
  compare: string[];
}

/** A positive whole number from a flag, or an error naming the flag. */
function whole(flag: string, value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} needs a whole number`);
  return number;
}

// Decision: unknown profiles and bad numbers stop the run. A typo such as "--profile holidays"
// used to run the mixed requests under the typo's label and quietly compare the wrong thing.
function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    src: join(HERE, "../src"),
    label: "baseline",
    count: 3000,
    seed: 20260924,
    profile: "mixed",
    out: null,
    compare: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1] ?? "";
    if (argv[i] === "--src") args.src = resolve(value);
    else if (argv[i] === "--label") args.label = value;
    else if (argv[i] === "--count") args.count = whole("--count", value);
    else if (argv[i] === "--seed") args.seed = whole("--seed", value);
    else if (argv[i] === "--profile") {
      const profile = PROFILES.find((name) => name === value);
      if (!profile) throw new Error(`--profile must be one of ${PROFILES.join(", ")}`);
      args.profile = profile;
    } else if (argv[i] === "--out") args.out = resolve(value);
    else if (argv[i] === "--compare") {
      args.compare = argv.slice(i + 1);
      break;
    } else continue;
    i++;
  }
  return args;
}

/** The planner under test: the same entry points the API uses, from any copy of src. */
interface PlannerUnderTest {
  buildDataset: typeof buildDataset;
  buildPlannerContext: typeof buildPlannerContext;
  planDeterministic: (request: TripRequest, ctx: PlannerContext) => Itinerary;
}

async function run(args: Args): Promise<void> {
  const raw: unknown = JSON.parse(readFileSync(DATA, "utf8"));
  // Decision: two contexts. The copy under test plans with its own; every measurement uses the
  // checked-out planner's, so a copy that changed a rule cannot also change how it is judged.
  const judge = buildPlannerContext(buildDataset(raw).places);
  const planner = (await import(
    pathToFileURL(join(args.src, "index.ts")).href
  )) as PlannerUnderTest;
  const own = planner.buildPlannerContext(planner.buildDataset(raw).places);
  const requests = sweepRequests(judge, args.count, args.seed, args.profile);
  // Warm-up. A request that throws here throws again below, where it counts as a failure.
  for (const request of requests.slice(0, 20)) {
    try {
      planner.planDeterministic(request, own);
    } catch {}
  }
  const rows: PlanRow[] = requests.map((request, n) => {
    const segments = segmentsOf(request, tripDates(request.startDate));
    const started = performance.now();
    try {
      const itinerary = planner.planDeterministic(request, own);
      const ms = performance.now() - started;
      return { n, segments, ms, ...measurePlan(itinerary, judge) };
    } catch (error) {
      const failed = error instanceof Error ? error.message : String(error);
      return { n, segments, ms: performance.now() - started, failed };
    }
  });
  const segments = [...new Set(rows.flatMap((row) => row.segments))];
  const bySegment = Object.fromEntries(
    segments.map((name) => [name, summarize(rows.filter((row) => row.segments.includes(name)))]),
  );
  const result = {
    label: args.label,
    src: args.src,
    seed: args.seed,
    profile: args.profile,
    coverage: coverage(requests),
  };
  console.log(`${args.label}: ${JSON.stringify(result.coverage)}`);
  printTable([args.label], [bySegment.all ?? {}]);
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    const file = join(args.out, `${args.label}.json`);
    writeFileSync(file, `${JSON.stringify({ ...result, bySegment, rows }, null, 1)}\n`);
    console.log(`wrote ${file}`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare.length > 0) compare(args.compare);
  else await run(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
