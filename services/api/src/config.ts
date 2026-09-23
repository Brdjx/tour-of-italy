import { z } from "zod";

// Reads process.env once at startup and turns it into a typed config object.
// Invalid values stop the process with a clear message. A missing API key is not an error:
// the planner then runs without the AI layer and the UI says so.

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .default(true);

const positiveInt = z.coerce.number().int().positive();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: positiveInt.default(8787),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY_PARAM: z.string().startsWith("/").optional(),
    ORIGIN_VERIFY_PARAM: z.string().startsWith("/").optional(),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5"),
    LLM_ENABLED: booleanString,
    LLM_TIMEOUT_MS: positiveInt.default(12_000),
    // Decision: 24 s total leaves headroom under API Gateway's 30 s cap for the fallback path.
    PLAN_DEADLINE_MS: positiveInt.default(24_000),
    LLM_MAX_ATTEMPTS: positiveInt.max(3).default(2),
    // Decision: default effort "low". Picking and ordering place IDs is not deep reasoning,
    // and latency matters more here than a marginal quality gain.
    LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    GIT_SHA: z.string().min(1).default("local"),
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
  });

export type Env = z.infer<typeof EnvSchema>;

export type Config = {
  nodeEnv: Env["NODE_ENV"];
  isProduction: boolean;
  port: number;
  anthropicApiKey: string | undefined;
  anthropicKeyParam: string | undefined;
  originVerifyParam: string | undefined;
  model: string;
  llmEnabled: boolean;
  llmTimeoutMs: number;
  planDeadlineMs: number;
  llmMaxAttempts: number;
  llmEffort: Env["LLM_EFFORT"];
  logLevel: Env["LOG_LEVEL"];
  gitSha: string;
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

function describeIssues(error: z.ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    lines.push(`  ${issue.path.join(".") || "(env)"}: ${issue.message}`);
  }
  return lines.join("\n");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(dropEmptyValues(env));
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${describeIssues(parsed.error)}`);
  }
  const values = parsed.data;
  return {
    nodeEnv: values.NODE_ENV,
    isProduction: values.NODE_ENV === "production",
    port: values.PORT,
    anthropicApiKey: values.ANTHROPIC_API_KEY,
    anthropicKeyParam: values.ANTHROPIC_API_KEY_PARAM,
    originVerifyParam: values.ORIGIN_VERIFY_PARAM,
    model: values.ANTHROPIC_MODEL,
    llmEnabled: values.LLM_ENABLED,
    llmTimeoutMs: values.LLM_TIMEOUT_MS,
    planDeadlineMs: values.PLAN_DEADLINE_MS,
    llmMaxAttempts: values.LLM_MAX_ATTEMPTS,
    llmEffort: values.LLM_EFFORT,
    logLevel: values.LOG_LEVEL,
    gitSha: values.GIT_SHA,
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
