import {
  DataIssueSchema,
  DataSummarySchema,
  ExcludedRecordSchema,
  IdSchema,
  ItinerarySchema,
  PlaceSchema,
  RecordIdSchema,
} from "@italy/planner";
import { z } from "zod";

// Zod schemas for the API responses the planner package does not define. Places, itineraries,
// data issues and summaries use the planner's own schemas; these wrap them in the response
// envelopes and describe /api/meta and error bodies. Every response is parsed before use.

// Decision: meta and envelopes use z.object (unknown keys dropped), not strictObject. A field
// the API adds later must not break the page; the fields we read are still fully checked.

/** One base (anchor) offered in the form. */
export const MetaAnchorSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  region: z.string().max(80).optional(),
  placeCount: z.number().int().min(0).max(10_000).optional(),
});

/** One interest chip: a canonical tag, its label, and how many places carry it. */
export const MetaInterestSchema = z.object({
  tag: z.string().min(1).max(40),
  label: z.string().min(1).max(60).optional(),
  count: z.number().int().min(0).max(10_000),
});

/** The planner's dataVersion of the place data: 16 hex characters. */
export const DataVersionSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** GET /api/meta. Only the lists the form shows are required. */
export const MetaSchema = z.object({
  anchors: z.array(MetaAnchorSchema).min(1).max(100),
  interests: z.array(MetaInterestSchema).max(500),
  dataVersion: DataVersionSchema.optional(),
});
export type Meta = z.output<typeof MetaSchema>;

const MAX_PLACES = 5000;

/** GET /api/places: a bare array or `{ places: [...] }`, each a full planner Place. */
export const PlacesResponseSchema = z.union([
  z.array(PlaceSchema).max(MAX_PLACES),
  z.object({ places: z.array(PlaceSchema).max(MAX_PLACES) }).transform((body) => body.places),
]);

/** GET /api/data-issues: the plain-language summary, the raw issues, or both. */
export const DataIssuesResponseSchema = z
  .object({
    summary: DataSummarySchema.optional(),
    issues: z.array(DataIssueSchema).max(20_000).optional(),
    excluded: z.array(ExcludedRecordSchema).max(MAX_PLACES).optional(),
  })
  .refine((body) => body.summary !== undefined || body.issues !== undefined, {
    message: "Expected a summary or a list of issues",
  });
export type DataIssuesResponse = z.output<typeof DataIssuesResponseSchema>;

/** GET /api/health. */
export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string().max(40),
  commit: z.string().max(80),
});
export type Health = z.output<typeof HealthSchema>;

/** Who chose a saved trip's places, as far as the API's records show. */
export const PLANNED_BY = ["ai", "ai_repaired", "rules"] as const;
export type PlannedBy = (typeof PLANNED_BY)[number];

/**
 * GET /api/trips/:id: a saved trip exactly as it was saved. The itinerary is checked like any
 * plan; planId is refused, because a saved trip is its own record.
 */
export const SavedTripSchema = z.object({
  v: z.literal(1),
  id: RecordIdSchema,
  itinerary: ItinerarySchema.omit({ planId: true }),
  origin: z.object({ plannedBy: z.enum(PLANNED_BY), edited: z.boolean() }),
  dataVersion: DataVersionSchema,
  createdAt: z.iso.datetime(),
});
export type SavedTripResponse = z.output<typeof SavedTripSchema>;

/** POST /api/trips: the new trip's id. */
export const SaveTripResponseSchema = z.object({ id: RecordIdSchema });

/** Every API error: `{ error: { code, message, details?, requestId } }`. */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().max(500),
    details: z.unknown().optional(),
    requestId: z.string().max(120).optional(),
  }),
});
export type ApiErrorBody = z.output<typeof ApiErrorBodySchema>["error"];
