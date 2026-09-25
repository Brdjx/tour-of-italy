import {
  IdSchema,
  type Itinerary,
  type KnownValues,
  RecordIdSchema,
  TRIP_DAYS,
  tripRequestSchemaFor,
} from "@italy/planner";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { TripSnapshot } from "../contract";
import type { AppData } from "../data";
import { type AppEnv, platformSourceIp } from "../lib/appEnv";
import { readJsonBody } from "../lib/body";
import { clientIp, rateLimitKey } from "../lib/clientIp";
import { CACHE_CONTROL } from "../lib/httpCache";
import { sendError, zodDetails } from "../lib/httpErrors";
import type { LogFields } from "../lib/logger";
import type { RateLimiter } from "../lib/rateLimit";
import type { RandomSource } from "../trips/ids";
import { rebuildTrip } from "../trips/rebuild";
import {
  type AiSource,
  MAX_STOPS_PER_DAY,
  readPlanRecord,
  readTripSnapshot,
  sourceFromPlan,
  sourceFromTrip,
} from "../trips/records";
import {
  expiresAtFrom,
  KEEP_SECONDS,
  planKey,
  STORE_TIMEOUT_MS,
  saveNew,
  type TripStore,
  tripKey,
  withinTime,
} from "../trips/store";

// Saved trips. POST /api/trips takes a trip as ids (the request, and each day's base and place
// ids in order) plus the planId of the AI plan it came from, or the id of the saved trip it was
// opened from. The server rebuilds the trip itself (trips/rebuild.ts), refuses it when it breaks
// a rule, and stores the result as a snapshot under a new id. GET /api/trips/:id returns that
// snapshot exactly as stored. Every text on a saved trip comes from the planner or from the
// store, so a link cannot carry text a stranger wrote.

export interface TripRouteDeps {
  data: AppData;
  now: () => number;
  store: TripStore | null; // null when saved trips are off (production without TRIPS_TABLE)
  rateLimiter: RateLimiter;
  dataVersion: string; // the fingerprint of the places this API serves
  random?: RandomSource; // for tests
}

/** Largest POST /api/trips body, the same cap as a plan request. A 3-day trip is under 2 KB. */
export const TRIP_BODY_MAX_BYTES = 16 * 1024;

/**
 * The body of POST /api/trips. Strict: a field such as `reasons` or `summary` is refused, not
 * ignored, so a client can never believe its text was saved.
 */
// Decision: tripId as a second place to find the AI content, beside planId. A trip opened from a
// saved link has no planId (a plan record lasts 90 days, a saved trip a year), so without it
// saving an opened trip again would lose the AI's why lines. Either id only points at our store.
export function saveTripSchema(known: KnownValues) {
  return z
    .strictObject({
      request: tripRequestSchemaFor(known),
      days: z
        .array(
          z.strictObject({
            anchorId: IdSchema,
            ids: z.array(IdSchema).max(MAX_STOPS_PER_DAY),
          }),
        )
        .length(TRIP_DAYS),
      planId: RecordIdSchema.optional(), // the AI plan the trip came from
      tripId: RecordIdSchema.optional(), // the saved trip it was opened from
    })
    .superRefine((body, context) => {
      body.days.forEach((day, index) => {
        if (!known.anchorIds.has(day.anchorId)) {
          context.addIssue({
            code: "custom",
            path: ["days", index, "anchorId"],
            message: "Unknown base id",
          });
        }
        day.ids.forEach((id, at) => {
          if (known.placeIds.has(id)) return;
          const path = ["days", index, "ids", at];
          context.addIssue({ code: "custom", path, message: "Unknown place id" });
        });
      });
      if (body.planId !== undefined && body.tripId !== undefined) {
        const message = "Send planId or tripId, not both";
        context.addIssue({ code: "custom", path: ["tripId"], message });
      }
    });
}

type SaveTripBody = z.output<ReturnType<typeof saveTripSchema>>;

const UNAVAILABLE = "Saved trips are not available right now. Try again in a moment.";

/** Records a failed store call on the log line (and the TripStoreFailures metric). */
function storeFailed(fields: LogFields, error: unknown): void {
  fields.tripStore = "error";
  fields.storeError = error;
}

/** The AI content the body points at, or null. Throws when the store fails. */
async function loadSource(
  store: TripStore,
  body: SaveTripBody,
  fields: LogFields,
): Promise<AiSource | null> {
  const ref =
    body.planId !== undefined
      ? { from: "plan" as const, key: planKey(body.planId) }
      : body.tripId !== undefined
        ? { from: "trip" as const, key: tripKey(body.tripId) }
        : null;
  if (ref === null) {
    fields.aiSource = "none";
    return null;
  }
  const text = await withinTime((signal) => store.get(ref.key, signal), STORE_TIMEOUT_MS.trip);
  let source: AiSource | null = null;
  if (text !== null && ref.from === "plan") {
    const record = readPlanRecord(text);
    source = record && sourceFromPlan(record);
  } else if (text !== null) {
    const snapshot = readTripSnapshot(text);
    source = snapshot && sourceFromTrip(snapshot);
  }
  // Decision: an expired, missing or unreadable record saves the trip with rule why lines,
  // rather than failing: the traveler still gets a link to the same places and times.
  fields.aiSource = text === null ? `${ref.from}_not_found` : source ? ref.from : "unusable";
  return source;
}

async function saveTrip(c: Context<AppEnv>, deps: TripRouteDeps, store: TripStore) {
  const fields = c.get("logFields");
  const body = await readJsonBody(c.req.raw, TRIP_BODY_MAX_BYTES);
  if (!body.ok) return sendError(c, body.status, body.code, body.message);
  const parsed = saveTripSchema(deps.data.known).safeParse(body.value);
  if (!parsed.success) {
    return sendError(c, 400, "bad_request", "The trip is not valid", zodDetails(parsed.error));
  }
  let source: AiSource | null;
  try {
    source = await loadSource(store, parsed.data, fields);
  } catch (error) {
    storeFailed(fields, error);
    return sendError(c, 503, "trips_unavailable", UNAVAILABLE);
  }
  const nowMs = deps.now();
  const createdAt = new Date(nowMs).toISOString();
  const rebuilt = rebuildTrip(parsed.data, source, deps.data.ctx, createdAt);
  if (!rebuilt.ok) {
    fields.violationCodes = rebuilt.errors.map((violation) => violation.code);
    const message = "This trip breaks a rule, so it cannot be saved. Fix the flagged stops first.";
    return sendError(c, 422, "trip_not_valid", message);
  }
  Object.assign(fields, rebuilt.origin);
  const expiresAt = expiresAtFrom(nowMs, KEEP_SECONDS.trip);
  // TripSnapshotSchema's shape; the itinerary already passed ItinerarySchema in rebuildTrip.
  const snapshot = (id: string): Omit<TripSnapshot, "itinerary"> & { itinerary: Itinerary } => ({
    v: 1,
    id,
    itinerary: rebuilt.itinerary,
    origin: rebuilt.origin,
    dataVersion: deps.dataVersion,
    createdAt,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
  try {
    const id = await saveNew(store, (id) => JSON.stringify(snapshot(id)), {
      prefix: "trip",
      expiresAt,
      timeoutMs: STORE_TIMEOUT_MS.trip,
      random: deps.random,
    });
    fields.tripStore = "ok";
    return c.json({ id }, 201);
  } catch (error) {
    storeFailed(fields, error);
    return sendError(c, 503, "trips_unavailable", UNAVAILABLE);
  }
}

async function openTrip(c: Context<AppEnv>, store: TripStore) {
  const fields = c.get("logFields");
  const id = c.req.param("id") ?? "";
  // Decision: a malformed id is simply not found. It never reaches the store, and the answer
  // does not tell a guesser anything about the id format.
  if (!RecordIdSchema.safeParse(id).success) {
    return sendError(c, 404, "not_found", "No saved trip has this link.");
  }
  let text: string | null;
  try {
    text = await withinTime((signal) => store.get(tripKey(id), signal), STORE_TIMEOUT_MS.trip);
  } catch (error) {
    storeFailed(fields, error);
    return sendError(c, 503, "trips_unavailable", UNAVAILABLE);
  }
  fields.tripStore = "ok";
  if (text === null) return sendError(c, 404, "not_found", "No saved trip has this link.");
  if (readTripSnapshot(text) === null) {
    // A stored trip this code cannot read is a bug or a format change, never the traveler's doing.
    fields.error = new Error("A stored trip failed its schema");
    return sendError(c, 500, "internal_error", "Something went wrong. Please try again.");
  }
  // The stored text itself, so the answer is exactly what was saved.
  c.header("Cache-Control", CACHE_CONTROL.savedTrip);
  c.header("Content-Type", "application/json");
  return c.body(text, 200);
}

export function registerTripRoutes(app: Hono<AppEnv>, deps: TripRouteDeps): void {
  app.post("/trips", async (c) => {
    const ip = clientIp((name) => c.req.header(name), platformSourceIp(c.env));
    const decision = deps.rateLimiter.take(rateLimitKey(ip));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      return sendError(c, 429, "rate_limited", "Too many saved trips. Try again in a minute.");
    }
    if (!deps.store) return sendError(c, 503, "trips_unavailable", UNAVAILABLE);
    return saveTrip(c, deps, deps.store);
  });
  app.get("/trips/:id", (c) => {
    if (!deps.store) return sendError(c, 503, "trips_unavailable", UNAVAILABLE);
    return openTrip(c, deps.store);
  });
}
