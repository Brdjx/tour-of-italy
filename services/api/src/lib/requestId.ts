import { randomUUID } from "node:crypto";

// Request ids tie a response to its log line. Outside production a caller-supplied x-request-id is
// kept when it is short and plain (test clients and the E2E runner send one); in production the id
// is always generated here, and what the client sent is only logged next to it.

export const REQUEST_ID_HEADER = "x-request-id";

// Decision: only letters, digits, and . _ : = - up to 128 characters. The id is echoed in a header
// and written to logs, so free text here would be a header or log injection vector.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:=-]{1,128}$/;

/** The incoming value when it is safe to log or echo, else undefined. */
export function safeRequestId(incoming: string | undefined): string | undefined {
  return incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : undefined;
}

export function resolveRequestId(
  incoming: string | undefined,
  generate: () => string = randomUUID,
): string {
  return safeRequestId(incoming) ?? generate();
}
