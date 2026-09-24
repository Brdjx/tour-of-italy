import { shippedData } from "@italy/api/data";
import { loadCases } from "./cases";
import { percent } from "./format";
import { buildLatest, type LatestBuild, writeLatest } from "./latest";
import { PATHS } from "./paths";

// pnpm eval:replay
//
// Offline and fast (CI runs it on every push): replays every committed recording through the
// current pipeline, runs the rules-only baseline, and regenerates results/latest.md. The one
// blocking assertion is that every replayed plan is valid. Model quality numbers are reported,
// never enforced, because they describe the model rather than the code. `pnpm test` also fails
// when the committed report differs from a fresh replay, so rerun this after any change that
// moves a number, and commit the new report.

function groupLabel(group: LatestBuild["groups"][number]): string {
  return group.kind === "live" ? `${group.model} ${group.promptVersion}` : group.kind;
}

function describe(build: LatestBuild): string[] {
  const lines = build.groups.map((g) => {
    const s = g.summary;
    const stale = g.stale.length === 0 ? "" : `, ${g.stale.length} stale`;
    return `${groupLabel(g)}: ${s.plans} plans, final valid ${percent(s.finalValidRate)}, first-pass valid ${percent(s.firstPassValidRate)}${stale}`;
  });
  const scenarios = build.groups.flatMap((g) => g.scenarios);
  const unexpected = scenarios.filter((s) => !s.asExpected);
  lines.push(
    `Guardrail recordings: ${scenarios.length - unexpected.length}/${scenarios.length} ended as expected`,
  );
  for (const s of unexpected) lines.push(`  ${s.caseId}: expected ${s.expected}, got ${s.got}`);
  return lines;
}

async function main(): Promise<number> {
  const started = performance.now();
  const cases = loadCases();
  const { ctx } = shippedData();
  const build = await buildLatest({ cases, ctx, recordingsDir: PATHS.recordings });
  const path = writeLatest(PATHS.results, build.markdown);
  for (const line of describe(build)) console.log(line);
  console.log(`Report: ${path} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
  if (build.plans === 0) {
    console.error("No recordings found to replay. Run `pnpm --filter @italy/evals eval:seed`.");
    return 1;
  }
  if (build.invalidPlans > 0) {
    console.error(`${build.invalidPlans} replayed plan(s) are not valid. That is a bug.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
