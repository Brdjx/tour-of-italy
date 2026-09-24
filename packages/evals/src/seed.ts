import { shippedData } from "@italy/api/data";
import { createSimulatedClient } from "@italy/api/llm/fixture";
import { validSelection } from "@italy/api/llm/fixtureAnswers";
import { PROMPT_VERSION } from "@italy/api/llm/prompt";
import { buildUserMessage } from "@italy/api/llm/promptUser";
import type { PlannerContext } from "@italy/planner";
import { ADVERSARIAL, type AdversarialScenario } from "./adversarial";
import { type EvalCase, loadCases } from "./cases";
import { RecordingClient } from "./clients";
import { PATHS } from "./paths";
import { candidateHash, pipelineSettings, runPlan, shortlistFor } from "./pipeline";
import { RECORDING_FORMAT, type Recording, type RecordingKind } from "./recording";
import { clearRecordings, writeRecording } from "./recordingStore";
import { REPLAY_NOW } from "./replayRun";
import { Scrubber } from "./scrub";

// Writes the offline recording sets, with no network and no key:
// - simulated: the scripted client on every case. It reruns the rules-only planner on the
//   shortlist and, for trips where the planner chooses the bases, takes the first two offered,
//   so its plans differ from the baseline's by that choice, not by any model judgment;
// - adversarial: the hand-written bad answers in adversarial.ts.
// Run it when the replay reports these as stale: pnpm --filter @italy/evals eval:seed

/** A fixed time, so re-seeding only changes files whose content changed. */
const SEEDED_AT = new Date(REPLAY_NOW).toISOString();

type Base = Omit<Recording, "attempt" | "turn" | "response" | "error" | "scenario">;

function baseRecording(kind: RecordingKind, caseDef: EvalCase, hash: string): Base {
  return {
    format: RECORDING_FORMAT,
    kind,
    caseId: caseDef.id,
    run: 1,
    model: kind,
    promptVersion: PROMPT_VERSION,
    recordedAt: SEEDED_AT,
    candidateHash: hash,
    request: caseDef.request,
  };
}

async function seedSimulated(caseDef: EvalCase, ctx: PlannerContext, scrubber: Scrubber) {
  const shortlist = shortlistFor(caseDef.request, ctx);
  const base = baseRecording("simulated", caseDef, candidateHash(shortlist, ctx));
  const client = new RecordingClient(createSimulatedClient(ctx), scrubber);
  const { config } = pipelineSettings();
  await runPlan(caseDef.request, client, ctx, { now: () => REPLAY_NOW, config });
  client.calls.forEach((call, index) => {
    writeRecording(PATHS.recordings, { ...base, attempt: index + 1, ...call }, scrubber);
  });
  return client.calls.length;
}

function seedAdversarial(
  scenario: AdversarialScenario,
  caseDef: EvalCase,
  ctx: PlannerContext,
  scrubber: Scrubber,
) {
  const shortlist = shortlistFor(caseDef.request, ctx);
  const base = baseRecording("adversarial", caseDef, candidateHash(shortlist, ctx));
  const user = buildUserMessage(caseDef.request, shortlist, ctx);
  const steps = scenario.steps(validSelection(caseDef.request, user, ctx));
  const { name, note, expectSource, expectFallbackReason } = scenario;
  steps.forEach((step, index) => {
    const outcome =
      "error" in step
        ? { error: step.error }
        : {
            response: {
              rawText: step.text,
              stopReason: step.stopReason,
              usage: { inputTokens: 0, outputTokens: 0 },
              latencyMs: step.latencyMs ?? 0,
              model: "adversarial",
            },
          };
    const scenarioInfo =
      index === 0 ? { scenario: { name, note, expectSource, expectFallbackReason } } : {};
    const recording = { ...base, attempt: index + 1, turn: step.turn, ...outcome, ...scenarioInfo };
    writeRecording(PATHS.recordings, recording, scrubber);
  });
  return steps.length;
}

async function main(): Promise<void> {
  const cases = loadCases();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ids = cases.map((c) => c.id);
  const { ctx } = shippedData();
  const scrubber = new Scrubber();
  const target = { promptVersion: PROMPT_VERSION };
  clearRecordings(PATHS.recordings, { ...target, kind: "simulated", model: "simulated" }, ids);
  clearRecordings(PATHS.recordings, { ...target, kind: "adversarial", model: "adversarial" }, ids);
  let simulated = 0;
  for (const caseDef of cases) simulated += await seedSimulated(caseDef, ctx, scrubber);
  let adversarial = 0;
  for (const scenario of ADVERSARIAL) {
    const caseDef = byId.get(scenario.caseId);
    if (caseDef === undefined) throw new Error(`Scenario "${scenario.name}" names no case`);
    adversarial += seedAdversarial(scenario, caseDef, ctx, scrubber);
  }
  console.log(`Wrote ${simulated} simulated and ${adversarial} adversarial recordings.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
