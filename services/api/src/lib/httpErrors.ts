import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { AppEnv } from "./appEnv";

// Every error response has one shape: { error: { code, message, details?, requestId } }. The
// message is fixed text chosen here, never an exception message, so internals cannot leak.

export type ErrorCode =
  | "bad_request"
  | "invalid_json"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_found"
  | "method_not_allowed"
  | "rate_limited"
  | "forbidden"
  | "unknown_fixture_scenario"
  | "no_feasible_plan"
  | "plan_unavailable"
  | "trip_not_valid"
  | "trips_unavailable"
  | "internal_error";

export interface ErrorDetail {
  path: string; // dotted field path, "" for the whole body
  message: string; // what is wrong, never the submitted value
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetail[]; requestId: string };
}

/** At most this many details are returned, so a huge invalid body gets a short answer. */
const MAX_DETAILS = 20;
const MAX_DETAIL_CHARS = 200;

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorBody {
  const error: ErrorBody["error"] = { code, message, requestId };
  if (details && details.length > 0) error.details = details.slice(0, MAX_DETAILS);
  return { error };
}

/** Sends an error response and records the code for the request log line. */
export function sendError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
): Response {
  // Paths outside /api never pass the request-id middleware, so both may be missing here.
  const fields = c.get("logFields") as AppEnv["Variables"]["logFields"] | undefined;
  if (fields) fields.errorCode = code;
  const requestId = (c.get("requestId") as string | undefined) ?? "none";
  return c.json(errorBody(code, message, requestId, details), status);
}

/**
 * Zod issues as details: the path and the rule, cut to a safe length. Unknown keys are reported
 * without their names, so no part of the submitted body is reflected back.
 */
export function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message:
      issue.code === "unrecognized_keys"
        ? "Unknown fields are not allowed"
        : issue.message.slice(0, MAX_DETAIL_CHARS),
  }));
}
