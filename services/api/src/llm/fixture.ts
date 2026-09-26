import type { PlannerContext } from "@italy/planner";
import type {
  LlmClient,
  LlmDayAnswer,
  LlmDayResult,
  LlmResult,
  LlmSelection,
  SelectInput,
} from "./client";
import { LlmError } from "./errors";
import {
  injectedSelection,
  leakyTextSelection,
  messySelection,
  validSelection,
  withClosedDayPick,
  withRepeat,
  withUnknownId,
} from "./fixtureAnswers";
import {
  injectedDayAnswer,
  leakyDayAnswer,
  messyDayAnswer,
  validDayAnswer,
  withClosedDayPlace,
  withRepeatedDay,
  withUnknownDayId,
} from "./fixtureDayAnswers";
import { parseDayAnswerText, parseSelectionText } from "./schema";

// A scripted model client. Each scenario says what the first call (select) and the repair call
// return, covering every way the real API can answer or fail, for a whole trip and for one day
// (selectDay, repairDay: POST /api/plan/day). Integration tests and E2E runs use it
// (LLM_MODE=fixture, scenario from the x-fixture-scenario header), so the ai, ai_repaired, and
// deterministic paths all run with no network and no key. Production refuses fixture mode.

export const FIXTURE_SCENARIOS = [
  "valid",
  "unknown-id-then-valid",
  "closed-day-tidied",
  "repeat-tidied",
  "messy-tidied",
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

/** What one scripted call does; T is the answer's shape (a whole trip, or one day). */
type Step<T> =
  | { kind: "answer"; build: (input: SelectInput, ctx: PlannerContext) => T }
  | { kind: "text"; text: string; stopReason: string }
  | { kind: "truncated" }
  | { kind: "throw"; error: () => Error }
  | { kind: "throwOnce"; error: () => Error; after: Step<T> } // first call throws, later calls run `after`
  | { kind: "slow" };

interface Script<T> {
  select: Step<T>;
  repair: Step<T>;
}

const valid: Step<LlmSelection> = {
  kind: "answer",
  build: (i, ctx) => validSelection(i.request, i.user, ctx),
};
const unknownId: Step<LlmSelection> = {
  kind: "answer",
  build: (i, ctx) => withUnknownId(validSelection(i.request, i.user, ctx)),
};
const fail = <T>(error: () => Error): Step<T> => ({ kind: "throw", error });

/** The scenarios every answer shape plays the same way. */
type SharedScenario =
  | "truncated"
  | "refusal"
  | "rate-limited"
  | "overloaded"
  | "server-error"
  | "connection-error"
  | "connection-reset-then-valid"
  | "slow-first-call"
  | "non-sdk-throw";

/** The steps every answer shape shares: failures, refusals, cut-off and slow answers. */
function sharedSteps<T>(valid: Step<T>): Record<SharedScenario, Script<T>> {
  return {
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
    "non-sdk-throw": {
      select: fail(() => new TypeError("Cannot read properties of undefined (reading 'content')")),
      repair: valid,
    },
  };
}

const SCRIPTS = {
  ...sharedSteps(valid),
  valid: { select: valid, repair: valid },
  "unknown-id-then-valid": { select: unknownId, repair: valid },
  // The next three first answers break only rules the model cannot see (a closed day, a repeat,
  // an order the scheduler cannot time). The tidy step fixes them before the check, so the plan
  // is ai_repaired with no repair call; the repair answer is there for a request it cannot fix.
  "closed-day-tidied": {
    select: {
      kind: "answer",
      build: (i, ctx) => withClosedDayPick(validSelection(i.request, i.user, ctx), i.user),
    },
    repair: valid,
  },
  "repeat-tidied": {
    select: {
      kind: "answer",
      build: (i, ctx) => withRepeat(validSelection(i.request, i.user, ctx)),
    },
    repair: valid,
  },
  "messy-tidied": {
    select: {
      kind: "answer",
      build: (i, ctx) => messySelection(validSelection(i.request, i.user, ctx), i.user),
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
  "slow-repair": { select: unknownId, repair: { kind: "slow" } },
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
} satisfies Record<FixtureScenario, Script<LlmSelection>>;

/** A day answer built from the valid one. */
const dayFrom = (
  change: (answer: LlmDayAnswer, input: SelectInput, ctx: PlannerContext) => LlmDayAnswer,
): Step<LlmDayAnswer> => ({
  kind: "answer",
  build: (i, ctx) => change(validDayAnswer(i.request, i.user, ctx), i, ctx),
});
const validDay = dayFrom((answer) => answer);
const unknownDayId = dayFrom((answer) => withUnknownDayId(answer));

// The same scenarios for one day (POST /api/plan/day). A repeat of another day's place and a
// place closed on the day's date are tidied away without a repair call; an id not offered is an
// error the repair turn fixes.
const DAY_SCRIPTS = {
  ...sharedSteps(validDay),
  valid: { select: validDay, repair: validDay },
  "unknown-id-then-valid": { select: unknownDayId, repair: validDay },
  "closed-day-tidied": {
    select: dayFrom((answer, i, ctx) => withClosedDayPlace(answer, i.user, ctx)),
    repair: validDay,
  },
  "repeat-tidied": {
    select: dayFrom((answer, i) => withRepeatedDay(answer, i.user)),
    repair: validDay,
  },
  "messy-tidied": {
    select: dayFrom((answer, i, ctx) => messyDayAnswer(answer, i.user, ctx)),
    repair: validDay,
  },
  "always-invalid": { select: unknownDayId, repair: unknownDayId },
  "schema-invalid": {
    select: { kind: "text", text: '{"placeIds":"all of them"}', stopReason: "end_turn" },
    repair: validDay,
  },
  "slow-repair": { select: unknownDayId, repair: { kind: "slow" } },
  "injection-echo": {
    select: dayFrom((answer) => injectedDayAnswer(answer)),
    repair: dayFrom((answer, _i, ctx) => leakyDayAnswer(answer, ctx)),
  },
} satisfies Record<FixtureScenario, Script<LlmDayAnswer>>;

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

/** How one answer shape is parsed, and its valid answer (cut short for "truncated"). */
interface Shape<T> {
  parse: (text: string) => { ok: true; value: T } | { ok: false; issues: string[] };
  valid: (input: SelectInput, ctx: PlannerContext) => T;
}

const TRIP_SHAPE: Shape<LlmSelection> = {
  parse: (text) => {
    const parsed = parseSelectionText(text);
    return parsed.ok ? { ok: true, value: parsed.selection } : parsed;
  },
  valid: (i, ctx) => validSelection(i.request, i.user, ctx),
};

const DAY_SHAPE: Shape<LlmDayAnswer> = {
  parse: (text) => {
    const parsed = parseDayAnswerText(text);
    return parsed.ok ? { ok: true, value: parsed.answer } : parsed;
  },
  valid: (i, ctx) => validDayAnswer(i.request, i.user, ctx),
};

/** One scripted call's result, with the parsed answer as `value`. */
type Scripted<T> = Omit<LlmResult, "selection"> & { value: T | null };

async function runStep<T>(
  step: Step<T>,
  input: SelectInput,
  ctx: PlannerContext,
  model: string,
  call: number,
  shape: Shape<T>,
): Promise<Scripted<T>> {
  const base = { latencyMs: 0, model };
  if (step.kind === "throw") throw step.error();
  if (step.kind === "throwOnce") {
    if (call === 1) throw step.error();
    return runStep(step.after, input, ctx, model, call, shape);
  }
  if (step.kind === "slow") return hang(input.signal);
  if (step.kind === "answer") {
    const text = JSON.stringify(step.build(input, ctx));
    const parsed = shape.parse(text);
    return {
      ...base,
      value: parsed.ok ? parsed.value : null,
      rawText: text,
      schemaIssues: parsed.ok ? [] : parsed.issues,
      usage: usageFor(input, text),
      stopReason: "end_turn",
    };
  }
  const text =
    step.kind === "truncated" ? JSON.stringify(shape.valid(input, ctx)).slice(0, 40) : step.text;
  const stopReason = step.kind === "truncated" ? "max_tokens" : step.stopReason;
  const parsed = stopReason === "end_turn" ? shape.parse(text) : null;
  const schemaIssues = parsed && !parsed.ok ? parsed.issues : [];
  return {
    ...base,
    value: null,
    rawText: text,
    schemaIssues,
    usage: usageFor(input, text),
    stopReason,
  };
}

/** A trip result from a scripted call. */
function tripResult({ value, ...rest }: Scripted<LlmSelection>): LlmResult {
  return { ...rest, selection: value };
}

/** A day result from a scripted call. */
function dayResult({ value, ...rest }: Scripted<LlmDayAnswer>): LlmDayResult {
  return { ...rest, answer: value };
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

  async select(input: SelectInput): Promise<LlmResult> {
    this.calls++;
    const step = SCRIPTS[this.scenario].select;
    return tripResult(await runStep(step, input, this.ctx, this.model, this.calls, TRIP_SHAPE));
  }

  async repair(input: SelectInput): Promise<LlmResult> {
    this.calls++;
    const step = SCRIPTS[this.scenario].repair;
    return tripResult(await runStep(step, input, this.ctx, this.model, this.calls, TRIP_SHAPE));
  }

  async selectDay(input: SelectInput): Promise<LlmDayResult> {
    this.calls++;
    const step = DAY_SCRIPTS[this.scenario].select;
    return dayResult(await runStep(step, input, this.ctx, this.model, this.calls, DAY_SHAPE));
  }

  async repairDay(input: SelectInput): Promise<LlmDayResult> {
    this.calls++;
    const step = DAY_SCRIPTS[this.scenario].repair;
    return dayResult(await runStep(step, input, this.ctx, this.model, this.calls, DAY_SHAPE));
  }
}

/** A client that always answers well: local development and E2E without a key. */
export function createSimulatedClient(ctx: PlannerContext): FixtureClient {
  return new FixtureClient(ctx, "valid");
}
