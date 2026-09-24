// Per-model request settings. Models differ in which knobs they accept, and sending the wrong one
// is a 400, so each supported model has an explicit entry instead of one shared parameter set.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSettings {
  family: "sonnet-5" | "haiku-4-5" | "unknown"; // which entry matched, for logs and tests
  temperature?: number; // sent only when set
  effort?: Effort; // sent as output_config.effort only when set
  maxTokens: number; // room for the JSON answer plus any adaptive thinking
}

/** Room for a full selection (about 1,500 tokens of JSON) plus thinking, well under SDK limits. */
export const MAX_OUTPUT_TOKENS = 8000;

/**
 * Settings for a model id.
 * - claude-sonnet-5: effort from LLM_EFFORT, no temperature (Sonnet 5 rejects it), thinking left
 *   to the model's default.
 * - claude-haiku-4-5 (and its dated ids): temperature 0.2, no effort (Haiku 4.5 rejects it), no
 *   thinking.
 * - anything else: neither knob. Every model accepts a request without them.
 */
// Decision: prefix matches on the family id, so a dated snapshot id gets its family's settings.
// Unknown ids get the conservative set rather than a guess that could fail every request.
export function settingsFor(model: string, effort: Effort): ModelSettings {
  if (model === "claude-sonnet-5" || model.startsWith("claude-sonnet-5-")) {
    return { family: "sonnet-5", effort, maxTokens: MAX_OUTPUT_TOKENS };
  }
  if (model === "claude-haiku-4-5" || model.startsWith("claude-haiku-4-5-")) {
    // Decision: 0.2 keeps choices close to deterministic for the same request while leaving
    // room to break ties differently from the rules-only planner.
    return { family: "haiku-4-5", temperature: 0.2, maxTokens: MAX_OUTPUT_TOKENS };
  }
  return { family: "unknown", maxTokens: MAX_OUTPUT_TOKENS };
}
