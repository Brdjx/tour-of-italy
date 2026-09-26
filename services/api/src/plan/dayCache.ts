import { createHash } from "node:crypto";
import { hasNotes, newTripErrors, type PlannerContext, planRequestKey } from "@italy/planner";
import { z } from "zod";
import { type PlanDayResponse, PlanDayResponseSchema } from "../contract";
import type { LruCache } from "../lib/cache";
import type { LogFields } from "../lib/logger";
import { expiresAtFrom, KEEP_SECONDS, type TripStore } from "../trips/store";
import type { DayInput } from "./dayInput";
import { type CacheLookup, parseJson, readStore, writeStore } from "./planCache";

// The AI day cache (POST /api/plan/day), so the same day of the same trip is not sent to the
// model twice: this instance's memory, then the shared table (item "cache#<key>", the plan
// cache's kind of item, for KEEP_SECONDS.cache), exactly as the plan cache works (planCache.ts).
// Only AI days are written. A day planned for a request with notes stays in memory only.

/** A cached day and when it stops being served, in epoch seconds. */
export interface CachedDay {
  result: PlanDayResponse;
  expiresAt: number;
}

export interface DayCacheDeps {
  memory: LruCache<CachedDay>;
  store: TripStore | null;
  now: () => number;
}

const DayCacheRecordSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("day"),
  expiresAt: z.number().int().positive(),
  result: PlanDayResponseSchema,
});

/**
 * The cache key for a day: SHA-256 of "day", the day prompt's version, the model client's
 * identity, the deployed commit, the data's fingerprint, the request's key (planRequestKey), each
 * other day's base and place ids in order, the day's index, its new base, and the places it
 * avoids (sorted). A change to any of them is another day.
 */
// Decision: the day's own current places are not in the key. The prompt never shows them (a new
// base has none of them, and a new version of the day at its base leaves out the ones it avoids),
// so two trips that differ only there get the same answer. A hit is still checked against the
// trip it is served to (readCachedDay), since the trip's other errors are judged with that day.
export function dayCacheKey(parts: {
  promptVersion: string;
  model: string;
  codeVersion: string;
  dataVersion: string;
  input: DayInput;
}): string {
  const { input } = parts;
  const others = input.days.map((day, index) =>
    index === input.day ? null : [day.anchorId, [...day.placeIds]],
  );
  const text = [
    "day",
    parts.promptVersion,
    parts.model,
    parts.codeVersion,
    parts.dataVersion,
    planRequestKey(input.request),
    JSON.stringify(others),
    String(input.day),
    input.anchorId,
    JSON.stringify([...input.avoid].sort()),
  ].join("\n");
  return createHash("sha256").update(text).digest("hex");
}

/** The day's record in the table, or null. The memory copy ends when the table item does. */
function parseRecord(text: string): CachedDay | null {
  const record = parseJson(text, DayCacheRecordSchema);
  return record && { result: record.result, expiresAt: record.expiresAt };
}

/** True when the cached day is this day, at this base, and adds no error to this trip. */
function fits(result: PlanDayResponse, input: DayInput, ctx: PlannerContext): boolean {
  if (result.day !== input.day || result.dayPlan.anchorId !== input.anchorId) return false;
  const day = {
    anchorId: result.dayPlan.anchorId,
    placeIds: result.dayPlan.stops.map((stop) => stop.placeId),
  };
  return newTripErrors(input.request, input.days, input.day, day, ctx).length === 0;
}

/**
 * The cached day for `key`, or undefined: memory first, then the table (not for a request with
 * notes), served only when it fits the trip. Sets fields.cache. Never throws.
 */
export async function readCachedDay(
  key: string,
  input: DayInput,
  deps: DayCacheDeps & { ctx: PlannerContext },
  fields: LogFields,
): Promise<PlanDayResponse | undefined> {
  let found = deps.memory.get(key);
  let lookup: CacheLookup = "hit-memory";
  if (found && found.expiresAt <= deps.now() / 1000) {
    deps.memory.delete(key);
    found = undefined;
  }
  if (!found && !hasNotes(input.request)) {
    found = await readStore(key, deps.store, fields, parseRecord);
    lookup = "hit-store";
  }
  if (!found || !fits(found.result, input, deps.ctx)) {
    fields.cache = "miss" satisfies CacheLookup;
    return undefined;
  }
  if (lookup === "hit-store") deps.memory.set(key, found);
  fields.cache = lookup;
  return found.result;
}

/**
 * Caches an AI day under `key`: in memory, and in the table when its request has no notes.
 * Never throws.
 */
// Decision: a day planned for notes is kept in memory only, as a plan is (planCache.ts): the
// table holds no personal data, and the day's AI reasons were written for the notes.
export async function cacheDay(
  key: string,
  input: DayInput,
  result: PlanDayResponse,
  deps: DayCacheDeps,
  fields: LogFields,
): Promise<void> {
  const expiresAt = expiresAtFrom(deps.now(), KEEP_SECONDS.cache);
  deps.memory.set(key, { result, expiresAt });
  if (hasNotes(input.request)) return;
  const text = JSON.stringify({ v: 1, kind: "day", expiresAt, result });
  await writeStore(key, text, expiresAt, deps.store, fields);
}
