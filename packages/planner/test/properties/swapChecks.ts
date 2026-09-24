import type { Alternative } from "../../src/alternatives";
import type { Itinerary } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { ctx } from "./arbitraries";
import { hardRuleProblems } from "./hardRules";

// What a swap must never do, checked the way the web app applies it: the candidate's rebuilt day
// replaces the old one with no further check (plan 9.6: "swap only offers alternatives that
// validate").

/** The itinerary with the candidate's rebuilt day in place, as the web reducer applies it. */
export function applySwap(
  itinerary: Itinerary,
  dayIndex: number,
  alternative: Alternative,
): Itinerary {
  const days = itinerary.days.map((day, index) => (index === dayIndex ? alternative.day : day));
  return { ...itinerary, days };
}

/** Problems with one applied swap: validator errors, broken hard rules, a changed day shape. */
export function swapProblems(
  itinerary: Itinerary,
  dayIndex: number,
  stopIndex: number,
  alternative: Alternative,
): string[] {
  const swapped = applySwap(itinerary, dayIndex, alternative);
  const problems = hardRuleProblems(swapped, ctx);
  for (const error of validateItinerary(swapped, ctx).filter((v) => v.severity === "error")) {
    problems.push(`validator: ${error.code} ${error.detail}`);
  }
  const before = itinerary.days[dayIndex]?.stops ?? [];
  const after = alternative.day.stops;
  const ids = after.map((stop, i) => (i === stopIndex ? before[i]?.placeId : stop.placeId));
  if (ids.join() !== before.map((stop) => stop.placeId).join()) problems.push("other stops moved");
  if (after[stopIndex]?.placeId !== alternative.place.id) problems.push("wrong place swapped in");
  if (after[stopIndex]?.role !== before[stopIndex]?.role) problems.push("role changed");
  return problems.map((text) => `${alternative.place.id}: ${text}`);
}
