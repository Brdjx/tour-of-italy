import { type Itinerary, ItinerarySchema, type Place, type TripRequest } from "@italy/planner";
import type { z } from "zod";
import { ApiError } from "./apiError";
import {
  ApiErrorBodySchema,
  type DataIssuesResponse,
  DataIssuesResponseSchema,
  type Health,
  HealthSchema,
  type Meta,
  MetaSchema,
  PlacesResponseSchema,
  type PlanDayResponse,
  PlanDayResponseSchema,
  type SavedTripResponse,
  SavedTripSchema,
  SaveTripResponseSchema,
} from "./apiSchemas";

// Client for the planner API. Every call has a deadline, every failure becomes an ApiError with
// a kind, and every successful body is parsed with a Zod schema before anything renders it.

// Decision: an unset NEXT_PUBLIC_API_BASE means "local API" under `next dev` and "same origin" in
// a build. Production is served from one CloudFront origin, so a forgotten variable in CI still
// produces a working site instead of one that calls localhost.
export function resolveApiBase(
  configured: string | undefined,
  nodeEnv: string | undefined,
): string {
  if (configured !== undefined) {
    return configured.replace(/\/+$/, "");
  }
  return nodeEnv === "development" ? "http://localhost:8787" : "";
}

export const API_BASE = resolveApiBase(process.env.NEXT_PUBLIC_API_BASE, process.env.NODE_ENV);

/** Deadlines in milliseconds. */
// Decision: 28 s for a plan. The API's own deadline is 24 s and API Gateway cuts at 30 s, so the
// client waits a little longer than the server ever should, then falls back to local planning.
export const TIMEOUTS = { read: 10_000, plan: 28_000 } as const;

export interface RequestOptions {
  signal?: AbortSignal; // caller cancellation
  timeoutMs?: number;
  base?: string; // defaults to API_BASE
  fetchImpl?: typeof fetch; // injected in tests
}

interface JsonRequest<S extends z.ZodType> {
  path: string;
  schema: S;
  method?: "GET" | "POST";
  body?: unknown;
  options?: RequestOptions;
}

/** Fetches JSON with a deadline and parses it with `schema`. Throws ApiError, never anything else. */
export async function requestJson<S extends z.ZodType>(
  request: JsonRequest<S>,
): Promise<z.output<S>> {
  const { path, schema, method = "GET", body, options = {} } = request;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? TIMEOUTS.read);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await sendRequest(path, method, body, options, controller.signal);
    const text = await response.text();
    if (!response.ok) throw httpError(response, text);
    return parseBody(text, schema);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError({ kind: "timeout", message: "The request timed out" });
    if (controller.signal.aborted) {
      throw new ApiError({ kind: "aborted", message: "The request was cancelled" });
    }
    throw new ApiError({ kind: "network", message: "The request could not reach the server" });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function sendRequest(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  options: RequestOptions,
  signal: AbortSignal,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const init: RequestInit = { method, signal, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { accept: "application/json", "content-type": "application/json" };
  }
  return fetchImpl(`${options.base ?? API_BASE}${path}`, init);
}

/** An http ApiError, with the server's code, message, details and request id when readable. */
function httpError(response: Response, text: string): ApiError {
  const fallback = { kind: "http" as const, status: response.status };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return new ApiError({ ...fallback, message: `The server answered ${response.status}` });
  }
  const parsed = ApiErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return new ApiError({ ...fallback, message: `The server answered ${response.status}` });
  }
  const { code, message, details, requestId } = parsed.data.error;
  return new ApiError({ ...fallback, code, message, details, requestId });
}

function parseBody<S extends z.ZodType>(text: string, schema: S): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError({ kind: "parse", message: "The server's reply was not JSON" });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Decision: report paths only. Zod messages can quote the received value, and a hostile or
    // broken response must not end up in the page or the console verbatim.
    const paths = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "(root)");
    throw new ApiError({
      kind: "schema",
      message: "The server's reply did not have the expected shape",
      details: paths,
    });
  }
  return parsed.data;
}

export function fetchHealth(options?: RequestOptions): Promise<Health> {
  return requestJson({ path: "/api/health", schema: HealthSchema, options });
}

export function fetchMeta(options?: RequestOptions): Promise<Meta> {
  return requestJson({ path: "/api/meta", schema: MetaSchema, options });
}

export function fetchPlaces(options?: RequestOptions): Promise<Place[]> {
  return requestJson({ path: "/api/places", schema: PlacesResponseSchema, options });
}

export function fetchDataIssues(options?: RequestOptions): Promise<DataIssuesResponse> {
  return requestJson({ path: "/api/data-issues", schema: DataIssuesResponseSchema, options });
}

export interface PlanCallOptions extends RequestOptions {
  deterministic?: boolean; // ?mode=deterministic, the rules-only path
}

/** POST /api/plan. The reply must be a full Itinerary or this throws a schema ApiError. */
export function postPlan(request: TripRequest, options: PlanCallOptions = {}): Promise<Itinerary> {
  const query = options.deterministic ? "?mode=deterministic" : "";
  return requestJson({
    path: `/api/plan${query}`,
    schema: ItinerarySchema,
    method: "POST",
    body: request,
    options: { timeoutMs: TIMEOUTS.plan, ...options },
  });
}

/**
 * What POST /api/plan/day takes: the trip as ids, the day, its new base, places to leave out, and
 * for a day of a route the route (a base id a day). With a route, every day is at its route city,
 * the days planned before this one have their stops, and later days may be empty (routeStartDays).
 */
export interface PlanDayBody {
  request: TripRequest; // the plan's own request, notes and all
  days: { anchorId: string; ids: string[] }[];
  day: number; // 0-based
  anchorId: string; // another city, or the day's own for new ideas; route[day] with a route
  avoid?: string[]; // the day's places, for new ideas at the same city; never with a route
  route?: string[]; // the route this day belongs to, from planRoute
}

/** POST /api/plan/day. The reply must be one planned day or this throws a schema ApiError. */
export function postPlanDay(
  body: PlanDayBody,
  options: PlanCallOptions = {},
): Promise<PlanDayResponse> {
  const query = options.deterministic ? "?mode=deterministic" : "";
  return requestJson({
    path: `/api/plan/day${query}`,
    schema: PlanDayResponseSchema,
    method: "POST",
    body,
    options: { timeoutMs: TIMEOUTS.plan, ...options },
  });
}

/** What POST /api/trips takes: the trip as ids, and where its AI content is on record. */
export interface SaveTripBody {
  request: TripRequest; // without the traveler's notes
  days: { anchorId: string; ids: string[] }[];
  planId?: string; // the AI plan it came from
  tripId?: string; // the saved trip it was opened from
}

/** POST /api/trips. Resolves to the new saved trip's id. */
export async function postTrip(body: SaveTripBody, options: RequestOptions = {}): Promise<string> {
  const reply = await requestJson({
    path: "/api/trips",
    schema: SaveTripResponseSchema,
    method: "POST",
    body,
    options,
  });
  return reply.id;
}

/** GET /api/trips/:id. The id must already be a record id (lib/savedTrip.ts checks it). */
export function fetchTrip(id: string, options: RequestOptions = {}): Promise<SavedTripResponse> {
  return requestJson({
    path: `/api/trips/${encodeURIComponent(id)}`,
    schema: SavedTripSchema,
    options,
  });
}
