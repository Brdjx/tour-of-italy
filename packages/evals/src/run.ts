import { shippedData } from "@italy/api/data";
import { createAnthropicClient } from "@italy/api/llm/anthropic";
import { PROMPT_VERSION } from "@italy/api/llm/prompt";
import { parseArgs, UsageError } from "./args";
import { loadCases, selectCases } from "./cases";
import { percent } from "./format";
import { buildLatest, writeLatest } from "./latest";
import { runLive } from "./liveRun";
import { PATHS } from "./paths";
import { pipelineSettings } from "./pipeline";
import { Scrubber } from "./scrub";

// pnpm eval [--model <id>] [--runs <n>] [--case <filter>]
//
// Runs every case (or the filtered ones) through the production pipeline with the real Claude
// client, `runs` times each, and records every call. Then replays all recordings offline and
// regenerates results/latest.md. Spends real tokens: needs ANTHROPIC_API_KEY in the environment.
//
// Exit codes: 0 done, 1 a plan was not valid, 2 bad options or no key, 3 the API rejected the
// key or the request and the run stopped early.

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  // Decision: the key is read from the environment only, never from a .env file. A live eval
  // spends money, so it runs only when someone has put the key there on purpose.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Nothing was called.");
    return 2;
  }
  const allCases = loadCases();
  const cases = selectCases(allCases, args.cases);
  const settings = pipelineSettings(process.env);
  const { ctx } = shippedData();
  console.log(
    `${cases.length} case(s) x ${args.runs} run(s) on ${args.model}, prompt ${PROMPT_VERSION}, effort ${settings.effort} (ignored by models that do not take it)`,
  );
  const result = await runLive({
    model: args.model,
    runs: args.runs,
    cases,
    ctx,
    client: createAnthropicClient({ apiKey, model: args.model, effort: settings.effort }),
    settings,
    scrubber: new Scrubber([apiKey]),
    recordingsDir: PATHS.recordings,
    resultsDir: PATHS.results,
    log: (line) => console.log(line),
  });
  const s = result.summary;
  console.log(
    `First-pass valid ${percent(s.firstPassValidRate)}, final valid ${percent(s.finalValidRate)}, fell back ${percent(s.fallbackRate)}. Results: ${result.resultsPath}`,
  );
  // Decision: the report is rebuilt even after an early stop. A stopped run saves only the cases
  // it finished, so the report still describes exactly the recordings on disk.
  const latest = await buildLatest({ cases: allCases, ctx, recordingsDir: PATHS.recordings });
  console.log(`Report: ${writeLatest(PATHS.results, latest.markdown)}`);
  if (result.stopped !== null) {
    console.error(`Stopped early: ${result.stopped}`);
    return 3;
  }
  return s.finalValidRate === 1 && latest.invalidPlans === 0 ? 0 : 1;
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
