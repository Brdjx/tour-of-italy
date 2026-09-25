import {
  addDays,
  type Itinerary,
  ItinerarySchema,
  type PlannerContext,
  RecordIdSchema,
  TRIP_DAYS,
  validationErrors,
} from "@italy/planner";
import { z } from "zod";
import { PLANNED_BY } from "./apiSchemas";
import type { PlanOrigin } from "./itineraryReducer";
import type { FallbackCause } from "./planRequest";
import type { SavedTrip } from "./savedTrip";
import { localIsoDate } from "./tripForm";

// The last plan, kept in localStorage so a reopened app (or an offline reload) shows it at once.
// What comes back out of storage is treated like any other untrusted input: anything that is
// not a readable, current, schema-valid plan for today's data is removed and never shown.

export const LAST_PLAN_KEY = "italy-planner.last-plan";
export const LAST_PLAN_VERSION = 1;
// Decision: a plan saved more than 90 days ago is stale even if the trip is still ahead. Hours
// and seasons change, and planning again takes seconds.
export const LAST_PLAN_MAX_AGE_DAYS = 90;
/** Longest stored value read, in characters. A plan is about 5 KB; this bounds parse work. */
export const LAST_PLAN_MAX_CHARS = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const StoredPlanSchema = z.strictObject({
  v: z.literal(LAST_PLAN_VERSION),
  savedAt: z.iso.datetime(),
  origin: z.enum(["api", "offline", "shared", "saved"]),
  // Why a browser-built plan was built there; absent in records saved before it was kept.
  cause: z.enum(["offline", "timeout", "busy", "server", "unreadable", "invalid"]).optional(),
  // True once the traveler has changed the plan on this device, so after a reload the source
  // line still says so and never claims the plan is as it arrived. Absent in older records.
  edited: z.boolean().optional(),
  // The saved trip a plan was opened from, so the source line still says so after a reload.
  saved: z
    .strictObject({
      id: RecordIdSchema,
      createdAt: z.iso.datetime(),
      plannedBy: z.enum(PLANNED_BY),
      edited: z.boolean(),
      retimed: z.boolean(),
    })
    .optional(),
  itinerary: ItinerarySchema,
});

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type DiscardReason = "unreadable" | "invalid" | "stale" | "data-changed";

export type LastPlanRead =
  | { status: "none" }
  | { status: "discarded"; reason: DiscardReason }
  | {
      status: "restored";
      itinerary: Itinerary;
      origin: PlanOrigin;
      cause: FallbackCause | null;
      saved: SavedTrip | null;
      edited: boolean;
      flagged: number;
    };

/** localStorage, or null when the browser blocks it (some private modes throw on access). */
export function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** What the page knows about the plan beyond the itinerary, kept with it. */
export interface LastPlanExtra {
  cause?: FallbackCause | null; // why the browser built it
  saved?: SavedTrip | null; // the saved trip it was opened from
  edited?: boolean; // the traveler has changed it on this device
}

// Decision: the trip notes are kept with the plan. They never leave this device (share links
// drop them), and without them "Edit trip" would come back with the notes box emptied.
/** Saves the plan. Returns false when storage is full or blocked; never throws. */
export function saveLastPlan(
  store: KeyValueStore,
  itinerary: Itinerary,
  origin: PlanOrigin,
  now: Date,
  { cause = null, saved = null, edited = false }: LastPlanExtra = {},
): boolean {
  const record = {
    v: LAST_PLAN_VERSION,
    savedAt: now.toISOString(),
    origin,
    ...(cause ? { cause } : {}),
    ...(edited ? { edited } : {}),
    ...(saved ? { saved } : {}),
    itinerary,
  };
  try {
    store.setItem(LAST_PLAN_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The saved plan if it is still usable with `ctx` on `now`. Removes it otherwise. Never throws. */
export function readLastPlan(store: KeyValueStore, ctx: PlannerContext, now: Date): LastPlanRead {
  let raw: string | null;
  try {
    raw = store.getItem(LAST_PLAN_KEY);
  } catch {
    return { status: "none" };
  }
  if (raw === null) return { status: "none" };
  let result: LastPlanRead;
  try {
    result = checkStored(raw, ctx, now);
  } catch {
    // The validator runs on data from storage; anything it throws on is a bad value, not a crash.
    result = { status: "discarded", reason: "invalid" };
  }
  if (result.status === "discarded") forget(store);
  return result;
}

/**
 * True when something is saved under the plan key, before it can be checked (that needs the
 * places). The page uses it only to show the plan's skeleton instead of the form while it waits.
 */
export function hasStoredPlan(store: KeyValueStore | null): boolean {
  try {
    return store?.getItem(LAST_PLAN_KEY) != null;
  } catch {
    return false;
  }
}

export function forget(store: KeyValueStore): void {
  try {
    store.removeItem(LAST_PLAN_KEY);
  } catch {
    // Blocked storage: nothing was restored, so there is nothing more to do.
  }
}

function checkStored(raw: string, ctx: PlannerContext, now: Date): LastPlanRead {
  if (raw.length > LAST_PLAN_MAX_CHARS) return { status: "discarded", reason: "unreadable" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "discarded", reason: "unreadable" };
  }
  const parsed = StoredPlanSchema.safeParse(json);
  if (!parsed.success) return { status: "discarded", reason: "invalid" };
  const { itinerary, origin, savedAt, cause, saved, edited } = parsed.data;
  if (isStale(itinerary, savedAt, now)) return { status: "discarded", reason: "stale" };
  if (!knownToData(itinerary, ctx)) return { status: "discarded", reason: "data-changed" };
  // Rule breaks are kept and flagged, as after an edit: the traveler sees what changed and can
  // swap or remove the stop.
  const flagged = validationErrors(itinerary, ctx).length;
  return {
    status: "restored",
    itinerary,
    origin,
    cause: cause ?? null,
    saved: saved ?? null,
    edited: edited ?? false,
    flagged,
  };
}

/** Saved too long ago, saved "in the future" (a changed clock or an edited value), or the trip is over. */
export function isStale(itinerary: Itinerary, savedAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(savedAt);
  if (age > LAST_PLAN_MAX_AGE_DAYS * DAY_MS || age < -DAY_MS) return true;
  const lastDay = addDays(itinerary.request.startDate, TRIP_DAYS - 1);
  return lastDay < localIsoDate(now);
}

/** Every base and place the plan names still exists in the loaded data. */
function knownToData(itinerary: Itinerary, ctx: PlannerContext): boolean {
  return itinerary.days.every(
    (day) =>
      ctx.anchorById.has(day.anchorId) &&
      day.stops.every((stop) => ctx.placesById.has(stop.placeId)),
  );
}

/** The sentence shown when a restored plan has stops that broke a rule since it was saved. */
export function restoredNote(flagged: number): string | null {
  if (flagged === 0) return null;
  return "Your last plan is back. Some stops no longer fit the current data and are marked.";
}
