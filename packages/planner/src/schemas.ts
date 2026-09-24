import { z } from "zod";
import {
  MAX_ANCHORS_PER_TRIP,
  REASON_MAX_CHARS,
  REQUEST_LIMITS,
  SUMMARY_MAX_CHARS,
  TRIP_DAYS,
} from "./config";
import { IdSchema, MinutesSchema, PriceLevelSchema } from "./dataSchemas";
import { parseIsoDate } from "./time";
import {
  FALLBACK_REASONS,
  type Itinerary,
  PACES,
  PLAN_SOURCES,
  type TripRequest,
  VIOLATION_CODES,
} from "./types";

// Zod schemas for everything that crosses the network (place and data-note schemas are in
// dataSchemas.ts and re-exported here). The API validates requests with
// TripRequestSchema (plus tripRequestSchemaFor for known ids); the web app parses every API
// response with these before rendering. The type checks at the bottom fail to compile if a
// schema and its type in types.ts drift apart.

export {
  AnchorSchema,
  DataIssueSchema,
  DataSummarySchema,
  ExcludedRecordSchema,
  IdSchema,
  MinutesSchema,
  PlaceSchema,
  PriceLevelSchema,
} from "./dataSchemas";

/** A real calendar date in YYYY-MM-DD form, inside the accepted year range. */
export const IsoDateSchema = z.string().refine((value) => {
  const date = parseIsoDate(value);
  return (
    date !== null && date.year >= REQUEST_LIMITS.minYear && date.year <= REQUEST_LIMITS.maxYear
  );
}, "Expected a real calendar date in YYYY-MM-DD form");

export const PaceSchema = z.enum(PACES);

// ---------- Trip request ----------

/** Structural validation of a trip request. Unknown fields are rejected, not ignored. */
export const TripRequestSchema = z
  .strictObject({
    startDate: IsoDateSchema,
    pace: PaceSchema,
    interests: z.array(z.string().min(1).max(40)).max(REQUEST_LIMITS.maxInterests).default([]),
    maxPriceLevel: PriceLevelSchema.nullable().default(null),
    anchors: z
      .union([z.literal("auto"), z.array(IdSchema).min(1).max(MAX_ANCHORS_PER_TRIP)])
      .default("auto"),
    mustInclude: z.array(IdSchema).max(REQUEST_LIMITS.maxMustInclude).default([]),
    exclude: z.array(IdSchema).max(REQUEST_LIMITS.maxExclude).default([]),
    notes: z.string().trim().max(REQUEST_LIMITS.notesMaxChars).optional(),
  })
  .superRefine((request, context) => {
    const lists = {
      interests: request.interests,
      mustInclude: request.mustInclude,
      exclude: request.exclude,
    };
    for (const [field, values] of Object.entries(lists)) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Contains the same value twice",
        });
      }
    }
    if (
      Array.isArray(request.anchors) &&
      new Set(request.anchors).size !== request.anchors.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["anchors"],
        message: "Contains the same base twice",
      });
    }
    const excluded = new Set(request.exclude);
    request.mustInclude.forEach((id, index) => {
      if (excluded.has(id)) {
        const message = "A place cannot be both required and excluded";
        context.addIssue({ code: "custom", path: ["mustInclude", index], message });
      }
    });
  });

/** Values a request may refer to. Built from the normalized data. */
export interface KnownValues {
  tags: ReadonlySet<string>; // interests on offer
  placeIds: ReadonlySet<string>; // schedulable place ids
  anchorIds: ReadonlySet<string>; // base ids
}

/**
 * TripRequestSchema plus checks against the data: every interest, place id, and base id must
 * exist. Messages give positions, never echo the input.
 */
export function tripRequestSchemaFor(known: KnownValues) {
  return TripRequestSchema.superRefine((request, context) => {
    const check = (values: string[], allowed: ReadonlySet<string>, field: string, noun: string) => {
      values.forEach((value, index) => {
        if (allowed.has(value)) return;
        context.addIssue({ code: "custom", path: [field, index], message: `Unknown ${noun}` });
      });
    };
    check(request.interests, known.tags, "interests", "interest");
    check(request.mustInclude, known.placeIds, "mustInclude", "place id");
    check(request.exclude, known.placeIds, "exclude", "place id");
    if (Array.isArray(request.anchors))
      check(request.anchors, known.anchorIds, "anchors", "base id");
  });
}

// ---------- Itinerary ----------

export const StopSchema = z
  .strictObject({
    placeId: IdSchema,
    start: MinutesSchema,
    end: MinutesSchema,
    travelFromPrevMin: z.number().int().min(0).max(1440),
    role: z.enum(["visit", "lunch", "dinner"]),
    reason: z.string().max(REASON_MAX_CHARS).optional(),
    reasonSource: z.enum(["ai", "rule"]).optional(),
  })
  .refine((stop) => stop.end > stop.start, {
    message: "A stop must end after it starts",
    path: ["end"],
  });

export const DayPlanSchema = z.strictObject({
  date: IsoDateSchema,
  anchorId: IdSchema,
  transferMin: z.number().int().min(0).max(1440),
  stops: z.array(StopSchema).max(20),
});

export const ViolationSchema = z.strictObject({
  code: z.enum(VIOLATION_CODES),
  severity: z.enum(["error", "warning"]),
  day: z.number().int().min(0).max(30).optional(),
  stopIndex: z.number().int().min(0).max(30).optional(),
  placeId: z.string().max(64).optional(),
  detail: z.string().max(500),
});

export const ItineraryMetaSchema = z.strictObject({
  model: z.string().max(100).optional(),
  promptVersion: z.string().max(20).optional(),
  attempts: z.number().int().min(0).max(10),
  latencyMs: z.number().min(0).max(600_000),
  fallbackReason: z.enum(FALLBACK_REASONS).optional(),
  generatedAt: z.iso.datetime(),
});

/** A plan as the API returns it. Errors never reach the traveler, so warnings only. */
export const ItinerarySchema = z.strictObject({
  request: TripRequestSchema,
  days: z.array(DayPlanSchema).length(TRIP_DAYS),
  source: z.enum(PLAN_SOURCES),
  warnings: z.array(ViolationSchema.extend({ severity: z.literal("warning") })),
  summary: z.string().max(SUMMARY_MAX_CHARS).optional(),
  meta: ItineraryMetaSchema,
});

// ---------- Compile-time agreement between schemas and types ----------

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type Both<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;

export type SchemaTypeChecks = [
  Assert<Both<z.output<typeof TripRequestSchema>, TripRequest>>,
  Assert<Extends<z.output<typeof ItinerarySchema>, Itinerary>>,
];
