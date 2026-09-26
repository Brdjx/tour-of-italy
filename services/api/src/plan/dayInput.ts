import {
  type DaySelection,
  IdSchema,
  type KnownValues,
  type PlannerContext,
  TRIP_DAYS,
  type TripRequest,
  tripRequestSchemaFor,
} from "@italy/planner";
import { z } from "zod";
import { MAX_STOPS_PER_DAY } from "../trips/records";

// What POST /api/plan/day plans: one day of a trip the page already has, at a base the traveler
// picked, alone or as one day of a route (a city a day the traveler set, planned a day at a time).
// The body carries the trip as ids only (the request, and each day's base and place ids in order,
// as POST /api/trips does), so nothing the client writes reaches the model or the page except ids
// chosen from the data and the request the plan route also takes.

/** One day of a trip to plan again, as the pipeline reads it. */
export interface DayInput {
  request: TripRequest;
  days: DaySelection[]; // the trip as the page has it: each day's base and place ids in order
  day: number; // the day to plan, 0-based
  anchorId: string; // its base: another city, or the day's own for a new version of it
  avoid: string[]; // places to leave out of the new version; a must-include is never left out
  route: string[] | null; // the route this day belongs to, a base id a day; null for one day alone
}

/**
 * The body of POST /api/plan/day. Strict, and checked against the data: every base and place id
 * is known, each place is in its day's base and appears once in the trip, and every day but the
 * one being planned has a stop. With `route`, every day is at the route's city (the day being
 * planned too), and a day after the one being planned may also be empty: it is a day of the route
 * still waiting its turn, since the page plans a route's days in day order.
 */
// Decision: a trip the page could not have made is refused, not planned around. The planner never
// puts a place on two days or in another day's base, and the page never empties a day, so such a
// body is a bug or a crafted request; the day's re-plan would otherwise have to guess which copy
// counts. Other rule breaks (a stop the traveler moved past its closing time) are allowed: they
// stay the trip's own, and the new day may not add any (dayBases.ts, newTripErrors).
// Decision: `avoid` is optional and holds at most a day's worth of ids. The page sends the day's
// current places when the traveler asks for a new version of it at the same city, so the new
// version is not the same day again (and is cached apart from it).
// Decision: the server tells a day still waiting in a route from a day the page emptied by its
// position alone. A route's days are planned in day order and each answer is put in before the
// next request, so every day before this one has its stops; a later day with none is waiting.
// Anything else stays a 400: an empty earlier day, an empty day with no route, a day away from
// the route's city, or `avoid` with a route (new ideas are for one day alone). The later days
// only decide which places count as used, and the answer is checked against the page's own trip.
export function planDayBodySchema(known: KnownValues, ctx: PlannerContext) {
  const ids = z.array(IdSchema).max(MAX_STOPS_PER_DAY);
  return z
    .strictObject({
      request: tripRequestSchemaFor(known),
      days: z.array(z.strictObject({ anchorId: IdSchema, ids })).length(TRIP_DAYS),
      day: z
        .number()
        .int()
        .min(0)
        .max(TRIP_DAYS - 1),
      anchorId: IdSchema,
      avoid: ids.optional(),
      route: z.array(IdSchema).length(TRIP_DAYS).optional(),
    })
    .superRefine((body, context) => {
      const issue = (path: (string | number)[], message: string) =>
        context.addIssue({ code: "custom", path, message });
      if (!known.anchorIds.has(body.anchorId)) issue(["anchorId"], "Unknown base id");
      const { route } = body;
      if (route !== undefined) {
        route.forEach((id, index) => {
          if (!known.anchorIds.has(id)) issue(["route", index], "Unknown base id");
        });
        if (route[body.day] !== body.anchorId) {
          issue(["anchorId"], "The day's base must be its city in the route");
        }
        if (body.avoid !== undefined) issue(["avoid"], "A route day takes no places to avoid");
      }
      const seen = new Set<string>();
      body.days.forEach((day, index) => {
        const knownBase = known.anchorIds.has(day.anchorId);
        if (!knownBase) issue(["days", index, "anchorId"], "Unknown base id");
        if (route !== undefined && route[index] !== day.anchorId) {
          issue(["days", index, "anchorId"], "This day's base is not its city in the route");
        }
        const waiting = route !== undefined && index > body.day;
        if (index !== body.day && !waiting && day.ids.length === 0) {
          const message =
            route === undefined
              ? "Only the day being planned may be empty"
              : "A day before the one being planned must have its stops";
          issue(["days", index, "ids"], message);
        }
        day.ids.forEach((id, at) => {
          const path = ["days", index, "ids", at];
          if (!known.placeIds.has(id)) {
            issue(path, "Unknown place id");
            return;
          }
          if (seen.has(id)) issue(path, "This place is already in the trip");
          seen.add(id);
          if (knownBase && ctx.anchorIdByPlaceId.get(id) !== day.anchorId) {
            issue(path, "This place is not in this day's base");
          }
        });
      });
      (body.avoid ?? []).forEach((id, at) => {
        if (!known.placeIds.has(id)) issue(["avoid", at], "Unknown place id");
      });
    });
}

export type PlanDayBody = z.output<ReturnType<typeof planDayBodySchema>>;

/** The body as the pipeline reads it. */
export function dayInputOf(body: PlanDayBody): DayInput {
  return {
    request: body.request,
    days: body.days.map((day) => ({ anchorId: day.anchorId, placeIds: day.ids })),
    day: body.day,
    anchorId: body.anchorId,
    avoid: body.avoid ?? [],
    route: body.route ?? null,
  };
}
