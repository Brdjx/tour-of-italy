import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlannerContext } from "@italy/planner";
import type { EvalCase } from "./cases";
import { measureBaseline } from "./measure";
import { LATEST_REPORT } from "./paths";
import { shortlistFor } from "./pipeline";
import { type ReplayedGroup, replayRecordings } from "./replayRun";
import { renderReport } from "./report";
import { type Summary, summarize } from "./summary";

// Builds latest.md from the committed recordings and the current code: replay every recording,
// run the rules-only baseline on every case, render. `pnpm eval:replay` and `pnpm eval` both end
// here, so the report is always reproducible from what is in the repository.

export interface LatestBuild {
  groups: ReplayedGroup[];
  baseline: Summary;
  markdown: string;
  plans: number; // replayed plans
  invalidPlans: number; // replayed plans that are not final valid: must be zero
}

/** The rules-only planner on every case. */
export function baselineSummary(cases: readonly EvalCase[], ctx: PlannerContext): Summary {
  return summarize(cases.map((c) => measureBaseline(c, shortlistFor(c.request, ctx), ctx)));
}

export async function buildLatest(options: {
  cases: readonly EvalCase[];
  ctx: PlannerContext;
  recordingsDir: string;
}): Promise<LatestBuild> {
  const { cases, ctx } = options;
  const groups = await replayRecordings(options.recordingsDir, cases, ctx);
  const baseline = baselineSummary(cases, ctx);
  const measures = groups.flatMap((g) => g.measures);
  return {
    groups,
    baseline,
    markdown: renderReport({ cases, groups, baseline }),
    plans: measures.length,
    invalidPlans: measures.filter((m) => !m.shape?.finalValid).length,
  };
}

/** Writes latest.md into the results folder and returns its path. */
export function writeLatest(resultsDir: string, markdown: string): string {
  const path = join(resultsDir, LATEST_REPORT);
  writeFileSync(path, markdown);
  return path;
}
