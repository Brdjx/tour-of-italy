import type { LogFields } from "./logger";

// CloudWatch metrics carried on the request log line in Embedded Metric Format. CloudWatch Logs
// turns the _aws block into metrics as the line arrives, so no metric filter, agent, or extra
// permission is needed. infra/sam/template.yaml alarms on these names; a test there imports them
// from here so the two cannot drift.
//
// Why: a handled 500, a 503, or every plan quietly falling back to rules-only all leave the
// Lambda Errors metric at zero, so only the function itself can count them.

export const METRIC_NAMESPACE = "italy-planner";
export const METRIC_DIMENSION = { name: "Service", value: "italy-planner-api" } as const;

export const METRIC_NAMES = {
  requests: "Requests", // every request
  serverErrors: "ServerErrors", // responses with status 500 or above
  aiPlans: "AiPlans", // plans computed where the model was expected to help
  aiFallbacks: "AiPlanFallbacks", // of those, plans that fell back to rules-only for any reason
  modelFailures: "AiPlanModelFailures", // of those, fallbacks because the model call failed or no key
} as const;

// Decision: "requested" (?mode=deterministic) and "disabled" (kill switch) are choices, not
// failures, so they are not AI plans at all. llm_error and no_key are what a revoked key, a
// wrong model parameter, or a missing SSM parameter look like: every plan degrades quietly.
const NOT_AI = new Set(["requested", "disabled"]);
const MODEL_FAILURE = new Set(["llm_error", "no_key"]);

/** Metric values for one request, from its status and its log fields. */
export function metricValues(status: number, fields: LogFields): Record<string, number> {
  const values: Record<string, number> = {
    [METRIC_NAMES.requests]: 1,
    [METRIC_NAMES.serverErrors]: status >= 500 ? 1 : 0,
  };
  const planned = typeof fields.source === "string" && fields.cache !== "hit";
  const reason = typeof fields.fallbackReason === "string" ? fields.fallbackReason : undefined;
  if (planned && !(reason !== undefined && NOT_AI.has(reason))) {
    values[METRIC_NAMES.aiPlans] = 1;
    values[METRIC_NAMES.aiFallbacks] = reason === undefined ? 0 : 1;
    values[METRIC_NAMES.modelFailures] = reason !== undefined && MODEL_FAILURE.has(reason) ? 1 : 0;
  }
  return values;
}

/** The Embedded Metric Format fields to merge into a log line. */
export function embeddedMetrics(status: number, fields: LogFields, nowMs: number): LogFields {
  const values = metricValues(status, fields);
  return {
    _aws: {
      Timestamp: nowMs,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[METRIC_DIMENSION.name]],
          Metrics: Object.keys(values).map((name) => ({ Name: name, Unit: "Count" })),
        },
      ],
    },
    [METRIC_DIMENSION.name]: METRIC_DIMENSION.value,
    ...values,
  };
}
