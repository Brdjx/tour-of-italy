import { z } from "zod";

// Reads process.env once at startup and turns it into a typed config object.
// Invalid values stop the process with a clear message. A missing API key is not an error:
// the planner then runs without the AI layer and the UI says so.

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .default(true);

const positiveInt = z.coerce.number().int().positive();

/** Longest plan deadline accepted: API Gateway gives up at 30 s, and the answer needs margin. */
export const MAX_PLAN_DEADLINE_MS = 26_000;

/** Which model client serves plans: the real Claude API, scripted fixtures, or none. */
export const LLM_MODES = ["anthropic", "fixture", "off"] as const;
export type LlmMode = (typeof LLM_MODES)[number];

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: positiveInt.default(8787),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY_PARAM: z.string().startsWith("/").optional(),
    ORIGIN_VERIFY_PARAM: z.string().startsWith("/").optional(),
    ANTHROPIC_MODEL: z.string().min(1).max(100).default("claude-sonnet-5"),
    LLM_ENABLED: booleanString,
    LLM_MODE: z.enum(LLM_MODES).optional(),
    // Decision: 15 s for a call, so a slow first answer is used instead of a fallback. At 12 s,
    // 1 of 166 live first calls on 2026-09-25 timed out (the slowest answer took 11.7 s), and a
    // timeout is not retried, so its plan fell back with about 10.5 s of the deadline unused.
    // With prompt v3, 2 of 134 live first answers took 13.8 and 14.4 s and became plans. A
    // repair gets at most what is left of the deadline after the reserve (planTrip.ts), so a
    // first answer at 15 s still leaves 7.5 s for it, over the 4 s minimum.
    LLM_TIMEOUT_MS: positiveInt.default(15_000),
    // Decision: 24 s total leaves headroom under API Gateway's 30 s cap for the fallback path.
    // Anything above 26 s could not answer before that cap, so it is refused at start.
    PLAN_DEADLINE_MS: positiveInt.max(MAX_PLAN_DEADLINE_MS).default(24_000),
    // Decision: at least 2, the first answer plus one repair. With 1 an invalid answer would be
    // labelled invalid_after_repair although no repair ran, and FALLBACK_REASONS has no better
    // label.
    LLM_MAX_ATTEMPTS: positiveInt.min(2).max(3).default(2),
    // Decision: default effort "low". Picking and ordering place IDs is not deep reasoning,
    // and latency matters more here than a marginal quality gain.
    LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    GIT_SHA: z.string().min(1).default("local"),
    // The DynamoDB table for saved trips and AI plan records (TripsTable in the SAM template).
    TRIPS_TABLE: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{3,255}$/)
      .optional(),
  })
  .superRefine((env, ctx) => {
    // Decision: in production the origin-verify check is not optional. Failing at cold start
    // is safer than serving /api to callers that bypass CloudFront and the WAF.
    if (env.NODE_ENV === "production" && env.ORIGIN_VERIFY_PARAM === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ORIGIN_VERIFY_PARAM"],
        message: "is required when NODE_ENV=production",
      });
    }
    if (env.LLM_TIMEOUT_MS > env.PLAN_DEADLINE_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_TIMEOUT_MS"],
        message: "must not be longer than PLAN_DEADLINE_MS",
      });
    }
    // Decision: scripted model answers must never serve real travelers, so production refuses
    // to start in fixture mode instead of quietly ignoring the setting.
    if (env.NODE_ENV === "production" && env.LLM_MODE === "fixture") {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_MODE"],
        message: "fixture mode is not allowed when NODE_ENV=production",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Why the AI layer is off, copied to meta.fallbackReason on every plan. */
export type LlmOffReason = "no_key" | "disabled";

export type Config = {
  nodeEnv: Env["NODE_ENV"];
  isProduction: boolean;
  port: number;
  anthropicApiKey: string | undefined;
  anthropicKeyParam: string | undefined;
  originVerifyParam: string | undefined;
  model: string;
  llmEnabled: boolean;
  llmMode: LlmMode;
  llmOffReason: LlmOffReason | undefined; // set only when llmMode is "off"
  llmTimeoutMs: number;
  planDeadlineMs: number;
  llmMaxAttempts: number;
  llmEffort: Env["LLM_EFFORT"];
  logLevel: Env["LOG_LEVEL"];
  gitSha: string;
  tripsTable: string | undefined; // unset: an in-memory store outside production, none in it
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

// Decision: treat empty strings as unset. `.env.example` ships `ANTHROPIC_API_KEY=` and a copied
// file should behave the same as no file at all.
function dropEmptyValues(env: Record<string, string | undefined>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") {
      cleaned[key] = value.trim();
    }
  }
  return cleaned;
}

// Decision: messages name the variable and the rule, never the value, so a mistyped key pasted
// into the wrong variable cannot end up in a crash log.
function describeIssues(error: z.ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    lines.push(`  ${issue.path.join(".") || "(env)"}: ${issue.message}`);
  }
  return lines.join("\n");
}

/**
 * The model client to use. An explicit LLM_MODE wins; otherwise the real client when a key
 * source exists, else none. LLM_ENABLED=false switches the AI layer off in every mode.
 */
function resolveLlmMode(values: Env): { mode: LlmMode; offReason: LlmOffReason | undefined } {
  const hasKey =
    values.ANTHROPIC_API_KEY !== undefined || values.ANTHROPIC_API_KEY_PARAM !== undefined;
  if (!values.LLM_ENABLED || values.LLM_MODE === "off") {
    return { mode: "off", offReason: "disabled" };
  }
  const wanted = values.LLM_MODE ?? (hasKey ? "anthropic" : "off");
  if (wanted === "fixture") return { mode: "fixture", offReason: undefined };
  if (wanted === "anthropic" && hasKey) return { mode: "anthropic", offReason: undefined };
  return { mode: "off", offReason: "no_key" };
}

// Decision: inside AWS Lambda (the runtime always sets AWS_LAMBDA_FUNCTION_NAME) only production
// is allowed. A missing NODE_ENV would otherwise default to development there, which turns the
// origin check and the fixture guard off without any error.
function refuseNonProductionLambda(env: Record<string, string>, values: Env): void {
  if (env.AWS_LAMBDA_FUNCTION_NAME !== undefined && values.NODE_ENV !== "production") {
    throw new ConfigError(
      "Invalid environment:\n  NODE_ENV: must be production when running in AWS Lambda",
    );
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = dropEmptyValues(env);
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${describeIssues(parsed.error)}`);
  }
  const values = parsed.data;
  refuseNonProductionLambda(cleaned, values);
  const llm = resolveLlmMode(values);
  return {
    nodeEnv: values.NODE_ENV,
    isProduction: values.NODE_ENV === "production",
    port: values.PORT,
    anthropicApiKey: values.ANTHROPIC_API_KEY,
    anthropicKeyParam: values.ANTHROPIC_API_KEY_PARAM,
    originVerifyParam: values.ORIGIN_VERIFY_PARAM,
    model: values.ANTHROPIC_MODEL,
    llmEnabled: values.LLM_ENABLED,
    llmMode: llm.mode,
    llmOffReason: llm.offReason,
    llmTimeoutMs: values.LLM_TIMEOUT_MS,
    planDeadlineMs: values.PLAN_DEADLINE_MS,
    llmMaxAttempts: values.LLM_MAX_ATTEMPTS,
    llmEffort: values.LLM_EFFORT,
    logLevel: values.LOG_LEVEL,
    gitSha: values.GIT_SHA,
    tripsTable: values.TRIPS_TABLE,
  };
}

// True when the AI layer is switched on and a key source exists. In production the key itself is
// read from SSM later, so a configured parameter name counts as a key source.
export function hasLlmKeySource(config: Config): boolean {
  if (!config.llmEnabled) {
    return false;
  }
  return config.anthropicApiKey !== undefined || config.anthropicKeyParam !== undefined;
}
