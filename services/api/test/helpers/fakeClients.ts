import type { LlmClient, LlmResult, RepairInput, SelectInput } from "../../src/llm/client";

// Hand-scripted model clients for unit tests that need exact control over each call.

export type Scripted = (input: SelectInput | RepairInput, call: number) => Promise<LlmResult>;

/** A client that runs `script` for every call and records the inputs. */
export class ScriptedClient implements LlmClient {
  readonly model: string;
  readonly inputs: (SelectInput | RepairInput)[] = [];

  constructor(
    private readonly script: Scripted,
    model = "scripted-model",
  ) {
    this.model = model;
  }

  select(input: SelectInput): Promise<LlmResult> {
    this.inputs.push(input);
    return this.script(input, this.inputs.length);
  }

  repair(input: RepairInput): Promise<LlmResult> {
    this.inputs.push(input);
    return this.script(input, this.inputs.length);
  }
}

/** A result with the given text, parsed by the caller's rules (selection set by the test). */
export function textResult(overrides: Partial<LlmResult> = {}): LlmResult {
  return {
    selection: null,
    rawText: "",
    schemaIssues: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 1,
    model: "scripted-model",
    stopReason: "end_turn",
    ...overrides,
  };
}

/** A promise that waits `ms` on the (possibly fake) timers, then resolves. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
