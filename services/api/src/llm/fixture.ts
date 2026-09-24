import type { PlannerContext } from "@italy/planner";
import type { LlmClient, LlmResult, LlmSelection, SelectInput } from "./client";
import { LlmError } from "./errors";
import {
  injectedSelection,
  leakyTextSelection,
  validSelection,
  withClosedDayPick,
  withUnknownId,
} from "./fixtureAnswers";
import { parseSelectionText } from "./schema";

// A scripted model client. Each scenario says what the first call (select) and the repair call
// return, covering every way the real API can answer or fail. Integration tests and E2E runs use
// it (LLM_MODE=fixture, scenario from the x-fixture-scenario header), so the ai, ai_repaired, and
// deterministic paths all run with no network and no key. Production refuses fixture mode.

export const FIXTURE_SCENARIOS = [
  "valid",
  "unknown-id-then-valid",
  "closed-day-then-valid",
  "always-invalid",
  "schema-invalid",
  "truncated",
  "refusal",
  "rate-limited",
  "overloaded",
  "server-error",
  "connection-error",
  "connection-reset-then-valid",
  "slow-first-call",
  "slow-repair",
  "non-sdk-throw",
  "injection-echo",
] as const;

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

export function isFixtureScenario(value: string): value is FixtureScenario {
  return (FIXTURE_SCENARIOS as readonly string[]).includes(value);
}

/** What one scripted call does. */
type Step =
  | { kind: "answer"; build: (input: SelectInput, ctx: PlannerContext) => LlmSelection }
  | { kind: "text"; text: string; stopReason: string }
  | { kind: "truncated" }
  | { kind: "throw"; error: () => Error }
  | { kind: "throwOnce"; error: () => Error; after: Step } // first call throws, later calls run `after`
  | { kind: "slow" };

const valid: Step = { kind: "answer", build: (i, ctx) => validSelection(i.request, i.user, ctx) };
const unknownId: Step = {
  kind: "answer",
  build: (i, ctx) => withUnknownId(validSelection(i.request, i.user, ctx)),
};
const fail = (error: () => Error): Step => ({ kind: "throw", error });

const SCRIPTS: Record<FixtureScenario, { select: Step; repair: Step }> = {
  valid: { select: valid, repair: valid },
  "unknown-id-then-valid": { select: unknownId, repair: valid },
  "closed-day-then-valid": {
    select: {
      kind: "answer",
      build: (i, ctx) => withClosedDayPick(validSelection(i.request, i.user, ctx), i.user),
    },
    repair: valid,
  },
  "always-invalid": { select: unknownId, repair: unknownId },
  "schema-invalid": {
    select: {
      kind: "text",
      text: '{"days":"three days please","summary":42}',
      stopReason: "end_turn",
    },
    repair: valid,
  },
  truncated: { select: { kind: "truncated" }, repair: valid },
  refusal: { select: { kind: "text", text: "", stopReason: "refusal" }, repair: valid },
  "rate-limited": {
    select: fail(() => new LlmError("rate_limited", "Rate limited", { status: 429 })),
    repair: valid,
  },
  overloaded: {
    select: fail(() => new LlmError("overloaded", "Overloaded", { status: 529 })),
    repair: valid,
  },
  "server-error": {
    select: fail(() => new LlmError("server_error", "Server error", { status: 500 })),
    repair: valid,
  },
  "connection-error": {
    select: fail(() => new LlmError("connection", "Connection failed")),
    repair: valid,
  },
  // A stale keep-alive socket: the first call fails, the pipeline's one retry succeeds.
  "connection-reset-then-valid": {
    select: {
      kind: "throwOnce",
      error: () => new LlmError("connection", "Connection reset"),
      after: valid,
    },
    repair: valid,
  },
  "slow-first-call": { select: { kind: "slow" }, repair: valid },
  "slow-repair": { select: unknownId, repair: { kind: "slow" } },
  "non-sdk-throw": {
    select: fail(() => new TypeError("Cannot read properties of undefined (reading 'content')")),
    repair: valid,
  },
  "injection-echo": {
    select: {
      kind: "answer",
      build: (i, ctx) => injectedSelection(validSelection(i.request, i.user, ctx)),
    },
    repair: {
      kind: "answer",
      build: (i, ctx) => leakyTextSelection(validSelection(i.request, i.user, ctx), ctx),
    },
  },
};

/** Waits until the call's signal fires, like a model that never answers in time. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const stop = () => reject(new LlmError("timeout", "Fixture call was aborted"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Rough token counts (four characters a token), so logs and evals see plausible numbers. */
function usageFor(input: SelectInput, text: string) {
  return {
    inputTokens: Math.ceil((input.system.length + input.user.length) / 4),
    outputTokens: Math.ceil(text.length / 4),
  };
}

async function runStep(
  step: Step,
  input: SelectInput,
  ctx: PlannerContext,
  model: string,
  call: number,
): Promise<LlmResult> {
  const base = { latencyMs: 0, model };
  if (step.kind === "throw") throw step.error();
  if (step.kind === "throwOnce") {
    if (call === 1) throw step.error();
    return runStep(step.after, input, ctx, model, call);
  }
  if (step.kind === "slow") return hang(input.signal);
  if (step.kind === "answer") {
    const text = JSON.stringify(step.build(input, ctx));
    const parsed = parseSelectionText(text);
    const selection = parsed.ok ? parsed.selection : null;
    const schemaIssues = parsed.ok ? [] : parsed.issues;
    return {
      ...base,
      selection,
      rawText: text,
      schemaIssues,
      usage: usageFor(input, text),
      stopReason: "end_turn",
    };
  }
  const text =
    step.kind === "truncated"
      ? JSON.stringify(validSelection(input.request, input.user, ctx)).slice(0, 40)
      : step.text;
  const stopReason = step.kind === "truncated" ? "max_tokens" : step.stopReason;
  const parsed = stopReason === "end_turn" ? parseSelectionText(text) : null;
  const schemaIssues = parsed && !parsed.ok ? parsed.issues : [];
  return {
    ...base,
    selection: null,
    rawText: text,
    schemaIssues,
    usage: usageFor(input, text),
    stopReason,
  };
}

/**
 * A client that plays one scenario. Its model id names the scenario ("fixture:valid"), so plans
 * from different scenarios never share a cache entry. Calls are counted for tests.
 */
export class FixtureClient implements LlmClient {
  readonly model: string;
  calls = 0;

  constructor(
    private readonly ctx: PlannerContext,
    readonly scenario: FixtureScenario = "valid",
  ) {
    this.model = `fixture:${scenario}`;
  }

  select(input: SelectInput): Promise<LlmResult> {
    this.calls++;
    return runStep(SCRIPTS[this.scenario].select, input, this.ctx, this.model, this.calls);
  }

  repair(input: SelectInput): Promise<LlmResult> {
    this.calls++;
    return runStep(SCRIPTS[this.scenario].repair, input, this.ctx, this.model, this.calls);
  }
}

/** A client that always answers well: local development and E2E without a key. */
export function createSimulatedClient(ctx: PlannerContext): FixtureClient {
  return new FixtureClient(ctx, "valid");
}
