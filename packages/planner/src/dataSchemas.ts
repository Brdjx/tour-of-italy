import { z } from "zod";
import { ID_MAX_CHARS } from "./config";
import { EXCLUSION_REASONS, ISSUE_KINDS, PLACE_TYPES } from "./enums";
import type { Assert, Both } from "./typeChecks";
import type { Anchor, DataIssue, DataSummary, ExcludedRecord, Place } from "./types";

// Zod schemas for places and data notes, as served by GET /api/places and GET /api/data-issues.
// The web app parses those responses with these before rendering anything.

const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${ID_MAX_CHARS}}$`);
const MAX_MINUTES = 2 * 1440; // past-midnight closings reach past 1440, never past two days

export const IdSchema = z.string().regex(ID_PATTERN, "Expected an id of letters, digits, _ or -");
export const PriceLevelSchema = z.literal([1, 2, 3, 4]);
export const MinutesSchema = z.number().int().min(0).max(MAX_MINUTES);

const TimeRangeSchema = z.strictObject({ open: MinutesSchema, close: MinutesSchema });
const DayRangesSchema = z.array(TimeRangeSchema);
const WeeklyHoursSchema = z.strictObject({
  0: DayRangesSchema,
  1: DayRangesSchema,
  2: DayRangesSchema,
  3: DayRangesSchema,
  4: DayRangesSchema,
  5: DayRangesSchema,
  6: DayRangesSchema,
});
const MonthDaySchema = z.strictObject({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});
const WeekdaySchema = z.literal([0, 1, 2, 3, 4, 5, 6]);
// 1..31, or -31..-1 counting from the end of the month (-1 is the last day).
const MonthDayBoundSchema = z
  .number()
  .int()
  .min(-31)
  .max(31)
  .refine((day) => day !== 0, "Day 0 is not a day of the month");
const DateRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("season"),
    window: z.strictObject({ from: MonthDaySchema, to: MonthDaySchema }),
    source: z.string(),
  }),
  z.strictObject({ kind: z.literal("weekdays"), days: z.array(WeekdaySchema), source: z.string() }),
  z.strictObject({
    kind: z.literal("day_of_month"),
    from: MonthDayBoundSchema,
    to: MonthDayBoundSchema,
    source: z.string(),
  }),
]);

export const DataIssueSchema = z.strictObject({
  placeId: z.string(),
  field: z.string(),
  kind: z.enum(ISSUE_KINDS),
  raw: z.string().nullable(),
  detail: z.string(),
  action: z.string(),
});

export const PlaceSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  type: z.enum(PLACE_TYPES),
  city: z.string().min(1),
  region: z.string().min(1),
  neighborhood: z.string().nullable(),
  description: z.string(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  locationSource: z.enum(["listed", "swapped", "neighborhood_centroid", "city_centroid"]),
  hours: WeeklyHoursSchema.nullable(),
  hoursConfidence: z.enum(["listed", "derived", "open_access", "unknown"]),
  hoursRaw: z.string().nullable(),
  hoursDerivation: z
    .strictObject({
      source: z.enum(["free_text", "name_hint", "open_access"]),
      match: z.string(),
      window: TimeRangeSchema,
    })
    .nullable(),
  dateRules: z.array(DateRuleSchema),
  seasonalNote: z.string().nullable(),
  durationMin: z.number().int().min(1).max(1440),
  durationSource: z.enum(["listed", "type_default", "clamped"]),
  priceLevel: PriceLevelSchema.nullable(),
  rating: z.number().min(0).max(5).nullable(),
  tags: z.array(z.string().min(1)),
  bookingRequired: z.boolean().nullable(),
  bookAhead: z.boolean(),
  mealCapable: z.boolean(),
  meals: z.array(z.enum(["lunch", "dinner"])),
  sharedLocationWith: z.array(IdSchema),
  issues: z.array(DataIssueSchema),
});

/** A record left out of planning, as listed in the data notes. */
export const ExcludedRecordSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().nullable(),
  reason: z.enum(EXCLUSION_REASONS),
  detail: z.string(),
});

/** A base (anchor) city and the places it serves. */
export const AnchorSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  region: z.string().min(1),
  centroid: z.strictObject({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  placeIds: z.array(IdSchema),
});

export const DataSummarySchema = z.strictObject({
  totals: z.strictObject({
    records: z.number().int().min(0),
    schedulable: z.number().int().min(0),
    excluded: z.number().int().min(0),
    issues: z.number().int().min(0),
  }),
  headline: z.string(),
  items: z.array(
    z.strictObject({
      kind: z.enum(ISSUE_KINDS),
      title: z.string(),
      explanation: z.string(),
      count: z.number().int().min(0),
      places: z.array(z.strictObject({ id: z.string(), name: z.string() })),
    }),
  ),
});

// Compile-time agreement between these schemas and the types in types.ts (typeChecks.ts).

export type DataSchemaTypeChecks = [
  Assert<Both<z.output<typeof PlaceSchema>, Place>>,
  Assert<Both<z.output<typeof DataIssueSchema>, DataIssue>>,
  Assert<Both<z.output<typeof DataSummarySchema>, DataSummary>>,
  Assert<Both<z.output<typeof ExcludedRecordSchema>, ExcludedRecord>>,
  Assert<Both<z.output<typeof AnchorSchema>, Anchor>>,
];
