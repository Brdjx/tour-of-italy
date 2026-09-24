import type { DayPlan } from "./types";

// The browser's edit helpers: each returns the day's new list of place ids, never changing the
// day on screen (undo keeps the old one). rescheduleDay (alternatives.ts) then times the list.

export function requireIndex(index: number, length: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${what} ${index} is out of range 0 to ${length - 1}`);
  }
}

export function idsOf(day: DayPlan): string[] {
  return day.stops.map((stop) => stop.placeId);
}

/** The day's ids without the stop at `stopIndex`. Throws RangeError on a bad index. */
export function removeStop(day: DayPlan, stopIndex: number): string[] {
  requireIndex(stopIndex, day.stops.length, "Stop");
  return idsOf(day).filter((_, index) => index !== stopIndex);
}

/** The day's ids with the stop at `from` moved to `to`. Throws RangeError on a bad index. */
export function moveStop(day: DayPlan, from: number, to: number): string[] {
  requireIndex(from, day.stops.length, "Stop");
  requireIndex(to, day.stops.length, "Stop");
  const ids = idsOf(day);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved as string);
  return ids;
}

/** The day's ids with the stop at `stopIndex` replaced by `placeId`. Throws on a bad index. */
export function replaceStop(day: DayPlan, stopIndex: number, placeId: string): string[] {
  requireIndex(stopIndex, day.stops.length, "Stop");
  const ids = idsOf(day);
  ids[stopIndex] = placeId;
  return ids;
}
