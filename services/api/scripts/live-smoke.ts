import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TripRequestSchema } from "@italy/planner";
import { shippedData } from "../src/data";
import { Redactor } from "../src/lib/redact";
import { createAnthropicClient } from "../src/llm/anthropic";
import type { Effort } from "../src/llm/models";
import { planTrip } from "../src/plan/planTrip";

// Manual live check against the real Claude API (never run in CI): one full plan per model
// through the production pipeline, printing what the log line would show. It spends real tokens.
//
//   ANTHROPIC_API_KEY=... pnpm --filter @italy/api live-smoke [model ...]
//
// Defaults to claude-sonnet-5 and claude-haiku-4-5-20251001. Exits 1 if any model's plan fell
// back to the rules-only planner. The key is read from the environment (or the repo's .env) and
// is never printed.

const DEFAULT_MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001"];

function loadKey(): string {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!process.env.ANTHROPIC_API_KEY && existsSync(envPath)) process.loadEnvFile(envPath);
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    console.error("ANTHROPIC_API_KEY is not set. Nothing was called.");
    process.exit(2);
  }
  return key;
}

/** A start date 30 days out, a typical trip. */
function startDate(): string {
  return new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
}

async function smoke(model: string, apiKey: string) {
  const { ctx } = shippedData();
  const effort = (process.env.LLM_EFFORT ?? "low") as Effort;
  const client = createAnthropicClient({ apiKey, model, effort });
  const request = TripRequestSchema.parse({
    startDate: startDate(),
    pace: "balanced",
    interests: ["historic", "food", "art"],
    notes: "We love long lunches and quiet evening walks.",
  });
  const outcome = await planTrip(request, {
    llm: client,
    ctx,
    now: Date.now,
    config: {
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 12_000),
      deadlineMs: Number(process.env.PLAN_DEADLINE_MS ?? 24_000),
      maxAttempts: 2,
    },
  });
  const { itinerary, trace } = outcome;
  // The API's own error messages are printed so a parameter mismatch can be diagnosed, scrubbed
  // the same way as a production log line.
  const redactor = new Redactor();
  redactor.addSecret(apiKey);
  return {
    model,
    source: itinerary.source,
    fallbackReason: itinerary.meta.fallbackReason ?? null,
    attempts: trace.attempts,
    latencyMs: itinerary.meta.latencyMs,
    llmLatencyMs: trace.llmLatencyMs,
    inputTokens: trace.usage.inputTokens,
    outputTokens: trace.usage.outputTokens,
    stopReasons: trace.stopReasons,
    violationCodes: trace.violationCodes,
    tidied: trace.tidied,
    llmErrors: trace.llmErrors,
    llmFailures: redactor.value(trace.llmFailures),
    reasonsKept: trace.reasonsKept,
    reasonRejections: trace.reasonRejections,
    days: itinerary.days.map((day) => `${day.date} ${day.anchorId}: ${day.stops.length} stops`),
    summary: itinerary.summary ?? null,
  };
}

async function main(): Promise<void> {
  const apiKey = loadKey();
  const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MODELS;
  let fellBack = false;
  for (const model of models) {
    const result = await smoke(model, apiKey);
    if (result.source === "deterministic") fellBack = true;
    console.log(JSON.stringify(result, null, 2));
  }
  if (fellBack) {
    console.error("At least one model fell back to the rules-only planner. See fallbackReason.");
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // Only the error's name and kind: an SDK message could carry request details.
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`Live smoke failed: ${name}`);
  process.exit(1);
});
