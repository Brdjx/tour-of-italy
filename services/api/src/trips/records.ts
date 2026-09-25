import {
  hasNotes,
  IdSchema,
  type Itinerary,
  REASON_MAX_CHARS,
  type StopRole,
  SUMMARY_MAX_CHARS,
  TRIP_DAYS,
  type TripRequest,
  TripRequestSchema,
} from "@italy/planner";
import { z } from "zod";
import { type TripSnapshot, TripSnapshotSchema } from "../contract";

// The records the store keeps, and the AI content a saved trip may carry. A plan record holds
// what the AI wrote for one plan (why lines, summary) and what it chose (bases, place ids), so
// POST /api/trips can put that content back on a trip rebuilt from ids. The content always comes
// from here or from an earlier saved trip, never from the request that saves the trip.

/** Most stops on one day, in a saved trip's body and in the planner's day schema. */
export const MAX_STOPS_PER_DAY = 20;

const DayIdsSchema = z.strictObject({
  anchorId: IdSchema,
  ids: z.array(IdSchema).max(MAX_STOPS_PER_DAY),
});

// Decision: each stored why line keeps its stop's role as well as its place and day. The planner
// carries an AI line over only to the same place in the same role (attachReasons), so "a long
// lunch" written for a lunch stop never lands on the same restaurant timed as a visit.
const StoredReasonSchema = z.strictObject({
  day: z
    .number()
    .int()
    .min(0)
    .max(TRIP_DAYS - 1),
  placeId: IdSchema,
  role: z.enum(["visit", "lunch", "dinner"]),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
});

/** An AI plan's content, stored under "plan#<planId>" for KEEP_SECONDS.plan (90 days). */
export const PlanRecordSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("plan"),
  request: TripRequestSchema, // as planned, without the traveler's notes
  days: z.array(DayIdsSchema).length(TRIP_DAYS),
  reasons: z.array(StoredReasonSchema).max(TRIP_DAYS * MAX_STOPS_PER_DAY), // AI why lines only
  summary: z.string().max(SUMMARY_MAX_CHARS).optional(),
  source: z.enum(["ai", "ai_repaired"]),
  model: z.string().max(100).optional(),
  promptVersion: z.string().max(20).optional(),
  createdAt: z.iso.datetime(),
});

export type PlanRecord = z.output<typeof PlanRecordSchema>;
export type DayIds = z.output<typeof DayIdsSchema>;

/** The request without the traveler's notes, which are private and never stored or shared. */
export function withoutNotes(request: TripRequest): TripRequest {
  const { notes: _notes, ...rest } = request;
  return rest;
}

/** Each day's base and place ids in visiting order. */
export function dayIdsOf(itinerary: Pick<Itinerary, "days">): DayIds[] {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    ids: day.stops.map((stop) => stop.placeId),
  }));
}

/** Every AI why line in the itinerary, with its day, place and role. */
function aiReasonsOf(itinerary: Itinerary): PlanRecord["reasons"] {
  return itinerary.days.flatMap((day, index) =>
    day.stops.flatMap((stop) =>
      stop.reasonSource === "ai" && stop.reason
        ? [{ day: index, placeId: stop.placeId, role: stop.role, reason: stop.reason }]
        : [],
    ),
  );
}

/** An itinerary the AI planner made. Only these are kept. */
export type AiItinerary = Itinerary & { source: "ai" | "ai_repaired" };

export function isAiItinerary(itinerary: Itinerary): itinerary is AiItinerary {
  return itinerary.source === "ai" || itinerary.source === "ai_repaired";
}

/**
 * The record kept for an AI plan. When the plan was made with the traveler's notes, the record
 * keeps none of the AI's text, no summary and no why line (privateAiText in the planner), so no
 * saved trip can carry an echo of the notes; every stop of such a trip gets the rule's why line.
 * The record still says the AI planned it, with its model and prompt version.
 */
// Decision: left out here, when the record is made, rather than when a trip is saved, so the
// table never holds AI text that may repeat the notes, and a trip saved again from a saved trip
// (sourceFromTrip) cannot bring it back either.
export function planRecordFrom(itinerary: AiItinerary, createdAt: string): PlanRecord {
  const { model, promptVersion } = itinerary.meta;
  const notes = hasNotes(itinerary.request);
  return {
    v: 1,
    kind: "plan",
    request: withoutNotes(itinerary.request),
    days: dayIdsOf(itinerary),
    reasons: notes ? [] : aiReasonsOf(itinerary),
    summary: notes ? undefined : itinerary.summary, // JSON leaves out whichever is undefined
    source: itinerary.source,
    model,
    promptVersion,
    createdAt,
  };
}

/** The AI content a trip being saved may carry, from a plan record or an earlier saved trip. */
export interface AiSource {
  from: "plan" | "trip";
  request: TripRequest; // what it was planned for
  days: DayIds[]; // its bases and ids, to tell whether the trip was edited since
  reasons: { day: number; placeId: string; role: StopRole; reason: string }[];
  summary?: string | undefined;
  source: "ai" | "ai_repaired";
  model?: string | undefined;
  promptVersion?: string | undefined;
  generatedAt: string; // when the AI plan was made
  edited: boolean; // an earlier saved trip that was itself edited
}

export function sourceFromPlan(record: PlanRecord): AiSource {
  return {
    from: "plan",
    request: record.request,
    days: record.days,
    reasons: record.reasons,
    summary: record.summary,
    source: record.source,
    model: record.model,
    promptVersion: record.promptVersion,
    generatedAt: record.createdAt,
    edited: false,
  };
}

/** The AI content of a saved trip, or null when the rules planned it. */
export function sourceFromTrip(snapshot: TripSnapshot): AiSource | null {
  const { itinerary, origin } = snapshot;
  if (origin.plannedBy === "rules") return null;
  const { model, promptVersion, generatedAt } = itinerary.meta;
  return {
    from: "trip",
    request: itinerary.request,
    days: dayIdsOf(itinerary),
    reasons: aiReasonsOf(itinerary),
    summary: itinerary.summary,
    source: origin.plannedBy,
    model,
    promptVersion,
    generatedAt,
    edited: origin.edited,
  };
}

/** A stored plan record, or null when the text is not one (a record from an older format). */
export function readPlanRecord(text: string): PlanRecord | null {
  return parseJson(text, PlanRecordSchema);
}

/** A stored trip snapshot, or null when the text is not one. */
export function readTripSnapshot(text: string): TripSnapshot | null {
  return parseJson(text, TripSnapshotSchema);
}

function parseJson<S extends z.ZodType>(text: string, schema: S): z.output<S> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
