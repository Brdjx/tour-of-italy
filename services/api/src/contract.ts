import {
  DataIssueSchema,
  DataSummarySchema,
  DayPlanSchema,
  ExcludedRecordSchema,
  IdSchema,
  ISSUE_KINDS,
  ItineraryMetaSchema,
  ItinerarySchema,
  PACES,
  PLACE_TYPES,
  PLAN_SOURCES,
  PlaceSchema,
  PriceLevelSchema,
  RecordIdSchema,
  TRIP_DAYS,
} from "@italy/planner";
import { z } from "zod";

// Zod schemas for every API response. The integration tests parse each route's output with
// these, and the web app can import them (`@italy/api/contract`) to parse responses before
// rendering. This file imports only zod and the planner, so it is safe in the browser.

const CountSchema = z.number().int().min(0);
/** The planner's dataVersion: 16 hex characters. */
export const DataVersionSchema = z.string().regex(/^[0-9a-f]{16}$/);
const ClockSchema = z.string().regex(/^\d{2}:\d{2}$/);

export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  version: z.string(),
  commit: z.string(),
  llmAvailable: z.boolean(), // whether AI planning can run right now
  model: z.string().nullable(), // the model plans would use; null when AI planning is off
});

export const MetaResponseSchema = z.strictObject({
  anchors: z.array(
    z.strictObject({
      id: IdSchema,
      name: z.string(),
      region: z.string(),
      placeCount: CountSchema,
      centroid: z.strictObject({ lat: z.number(), lng: z.number() }),
    }),
  ),
  interests: z.array(z.strictObject({ tag: z.string(), label: z.string(), count: CountSchema })),
  types: z.array(
    z.strictObject({ type: z.enum(PLACE_TYPES), label: z.string(), count: CountSchema }),
  ),
  priceLevels: z.array(z.strictObject({ level: PriceLevelSchema, label: z.string() })),
  tripDays: z.number().int().min(1),
  paces: z.array(
    z.strictObject({
      id: z.enum(PACES),
      label: z.string(),
      maxVisits: z.number().int().min(1),
      dayStart: ClockSchema,
      dayEnd: ClockSchema,
    }),
  ),
  meals: z.strictObject({
    lunch: z.strictObject({ earliestStart: ClockSchema, latestStart: ClockSchema }),
    dinner: z.strictObject({ earliestStart: ClockSchema, latestStart: ClockSchema }),
  }),
  limits: z.strictObject({
    maxInterests: CountSchema,
    maxMustInclude: CountSchema,
    maxExclude: CountSchema,
    maxAnchors: CountSchema,
    notesMaxChars: CountSchema,
    maxBodyBytes: CountSchema,
    earliestStartDate: z.iso.date(), // first start date the API accepts
    latestStartDate: z.iso.date(), // last start date whose whole trip fits the accepted years
  }),
  issueCounts: z.partialRecord(z.enum(ISSUE_KINDS), CountSchema),
  dataSummary: DataSummarySchema,
  dataVersion: DataVersionSchema, // fingerprint of /api/places (the planner's dataVersion)
});

export const PlaceNoteSchema = z.strictObject({ kind: z.string(), label: z.string() });

export const PlacesResponseSchema = z.strictObject({
  places: z.array(PlaceSchema), // every schedulable place, exactly the planner's Place shape
  chips: z.record(IdSchema, z.array(PlaceNoteSchema)), // data notes per place id
  approximateLocation: z.array(IdSchema), // places whose coordinates were estimated
});

export const DataIssuesResponseSchema = z.strictObject({
  totals: z.strictObject({
    records: CountSchema,
    schedulable: CountSchema,
    excluded: CountSchema,
    issues: CountSchema,
    byKind: z.partialRecord(z.enum(ISSUE_KINDS), CountSchema),
  }),
  issues: z.array(DataIssueSchema),
  excluded: z.array(ExcludedRecordSchema),
  summary: DataSummarySchema,
});

/** POST /api/plan answers with the itinerary itself. */
export const PlanResponseSchema = ItinerarySchema;

/**
 * POST /api/plan/day answers with the one day it planned: the day timed in its trip (date, base,
 * transfer from the day before, stops with times, roles and why lines, each marked "ai" or
 * "rule"), who chose its places, and the plan's meta (the model and the day prompt's version when
 * the AI layer ran, attempts, latency, and the fallback reason for a rules-only day). The other
 * days never change; the page applies the day with the planner's withReplannedDay, which also
 * times the next day again after its new transfer.
 */
export const PlanDayResponseSchema = z.strictObject({
  day: z
    .number()
    .int()
    .min(0)
    .max(TRIP_DAYS - 1),
  dayPlan: DayPlanSchema,
  source: z.enum(PLAN_SOURCES),
  meta: ItineraryMetaSchema,
});

/** Who chose a saved trip's places, as far as the API's own records show. */
export const PLANNED_BY = ["ai", "ai_repaired", "rules"] as const;

/**
 * A saved trip, as GET /api/trips/:id returns it: the itinerary exactly as it was saved (times,
 * roles, why lines with their source, summary, warnings; never the traveler's notes), how it was
 * planned, the data it was timed with, and when it was saved and expires. "rules" means no AI
 * plan record backed it, so its why lines and times are the rules' own.
 */
export const TripSnapshotSchema = z.strictObject({
  v: z.literal(1),
  id: RecordIdSchema,
  itinerary: ItinerarySchema.omit({ planId: true }),
  origin: z.strictObject({
    plannedBy: z.enum(PLANNED_BY),
    edited: z.boolean(), // its places or their order differ from the AI plan it came from
  }),
  dataVersion: DataVersionSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

/** POST /api/trips answers with the new trip's id. */
export const SaveTripResponseSchema = z.strictObject({ id: RecordIdSchema });

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string(),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type MetaResponse = z.infer<typeof MetaResponseSchema>;
export type PlacesResponse = z.infer<typeof PlacesResponseSchema>;
export type DataIssuesResponse = z.infer<typeof DataIssuesResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type TripSnapshot = z.infer<typeof TripSnapshotSchema>;
export type PlanDayResponse = z.infer<typeof PlanDayResponseSchema>;
export type PlannedBy = (typeof PLANNED_BY)[number];
