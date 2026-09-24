// Typed failures from the API client. Components never see a raw fetch error: every failure is
// one of these kinds, and describeApiError turns it into a plain sentence that says what to do.

export type ApiErrorKind =
  | "network" // fetch rejected: offline, DNS, CORS, connection reset
  | "timeout" // no answer before the client's deadline
  | "aborted" // the caller cancelled (a newer request replaced this one)
  | "http" // the server answered with a non-2xx status
  | "parse" // the body was not JSON
  | "schema"; // the JSON did not match the expected shape

export interface ApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  code?: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

const UNAVAILABLE = "The planner is unavailable. Try again in a moment.";

/** Statuses that mean our request was wrong, so retrying the same thing will not help. */
const REQUEST_PROBLEMS = new Set([400, 413, 415, 422]);

/** True when the request itself was rejected (bad input), as opposed to the service failing. */
export function isRequestProblem(error: unknown): boolean {
  return isApiError(error) && error.kind === "http" && REQUEST_PROBLEMS.has(error.status ?? 0);
}

/** One plain sentence for the traveler. Errors never apologize and always say what to do. */
export function describeApiError(error: unknown): string {
  if (!isApiError(error)) return UNAVAILABLE;
  if (error.kind === "http" && error.status === 429) {
    return "Too many plans in a short time. Wait a minute and try again.";
  }
  if (isRequestProblem(error)) {
    const fields = detailFields(error.details);
    const what = fields.length > 0 ? listText(fields) : "the form";
    return `Some trip details were not accepted. Check ${what}, then try again.`;
  }
  if (error.kind === "parse" || error.kind === "schema") {
    return "The planner sent a reply this page cannot read. Try again in a moment.";
  }
  return UNAVAILABLE;
}

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const FIELD_WORDS: Record<string, string> = {
  startDate: "the start date",
  pace: "the pace",
  interests: "the interests",
  maxPriceLevel: "the budget",
  anchors: "the bases",
  mustInclude: "the must-see places",
  exclude: "the places to skip",
  notes: "the notes",
};

/**
 * Field names from a 400 response's details, in words. Accepts the shapes a Zod error flattens
 * to ({ fieldErrors }, an issue array with `path`, or a list of field names) and ignores the
 * rest, so a detail format change can only lose the hint, never crash the page.
 */
export function detailFields(details: unknown): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    // Object.hasOwn, not `in`: "__proto__" and "constructor" are inherited keys of every object.
    if (typeof value === "string" && Object.hasOwn(FIELD_WORDS, value)) names.add(value);
  };
  if (Array.isArray(details)) {
    for (const item of details) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object" && "path" in item) {
        const path = (item as { path: unknown }).path;
        if (Array.isArray(path)) add(path[0]);
        else add(path);
      }
    }
  } else if (details && typeof details === "object" && "fieldErrors" in details) {
    const fieldErrors = (details as { fieldErrors: unknown }).fieldErrors;
    if (fieldErrors && typeof fieldErrors === "object") Object.keys(fieldErrors).forEach(add);
  }
  return [...names].map((name) => FIELD_WORDS[name] as string);
}
