import {
  DataIssueSchema,
  DataSummarySchema,
  ExcludedRecordSchema,
  IdSchema,
  ISSUE_KINDS,
  ItinerarySchema,
  PACES,
  PLACE_TYPES,
  PlaceSchema,
  PriceLevelSchema,
} from "@italy/planner";
import { z } from "zod";

// Zod schemas for every API response. The integration tests parse each route's output with
// these, and the web app can import them (`@italy/api/contract`) to parse responses before
// rendering. This file imports only zod and the planner, so it is safe in the browser.

const CountSchema = z.number().int().min(0);
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
