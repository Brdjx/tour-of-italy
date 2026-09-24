import { expect } from "vitest";
import { addDays } from "../../src/time";
import type { Itinerary, ViolationCode } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { ctx, stopOf } from "./fixtures";

// The shape of one mutation (a valid trip, one corruption, the error it must cause) and the
// helpers the mutation tables share.

export interface Mutation {
  name: string; // the corruption, in words
  build: () => Itinerary; // a valid trip
  corrupt: (plan: Itinerary) => void; // one change
  code: ViolationCode; // the error that must appear
  placeId?: string; // where it must point, when it is about a place
  day?: number; // the day it must point at, when it is about a day
}

/** Moves every date of a trip by `days`, start date included. */
export function shiftTrip(plan: Itinerary, days: number): void {
  plan.request.startDate = addDays(plan.request.startDate, days);
  for (const day of plan.days) day.date = addDays(day.date, days);
}

/** Sets a stop's start, keeping its length. */
export function moveStop(plan: Itinerary, day: number, index: number, start: number): void {
  const stop = stopOf(plan, day, index);
  stop.end = start + (stop.end - stop.start);
  stop.start = start;
}

/**
 * Asserts the trip starts with no errors and, after the corruption, has an error with the
 * mutation's code at the mutation's place or day.
 */
export function expectCaught(mutation: Mutation): void {
  const plan = mutation.build();
  const before = validateItinerary(plan, ctx()).filter((v) => v.severity === "error");
  expect(before).toEqual([]);
  mutation.corrupt(plan);
  const errors = validateItinerary(plan, ctx()).filter((v) => v.severity === "error");
  const match = errors.find(
    (v) =>
      v.code === mutation.code &&
      (mutation.placeId === undefined || v.placeId === mutation.placeId) &&
      (mutation.day === undefined || v.day === mutation.day),
  );
  expect(match, JSON.stringify(errors, null, 1)).toBeDefined();
}
