import { OPEN_ACCESS_WINDOW, type Place, type PlannerContext } from "@italy/planner";
import type { Health } from "./apiSchemas";
import { calendarDate, formatClock, typeWord } from "./format";
import { type PhotoCreditRow, photoCredits } from "./placePhotos";

// The numbers and lists in "About this data", computed from what the page loaded: the places,
// the planner's bases, the photo credits, and the health check's model. Nothing here is typed in
// by hand, so the overlay cannot say something the data does not.

/** One base: its own city's places, then the day-trip towns planned from it. */
export interface BaseRow {
  base: string;
  inCity: number;
  dayTrips: { city: string; count: number }[]; // most places first
  total: number;
}

export interface CountRow {
  label: string;
  count: number;
}

/** A photo credit with the name the list shows for it. */
export interface CreditRow extends PhotoCreditRow {
  name: string;
}

/** Place names listed per kind of note before "and N more". */
export const NAMES_SHOWN = 8;

/** "Colosseum, Pantheon and 3 more". */
export function namesText(places: readonly { name: string }[]): string {
  const names = places.slice(0, NAMES_SHOWN).map((place) => place.name);
  const rest = places.length - names.length;
  if (rest > 0) return `${names.join(", ")} and ${rest} more`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const byCountThenName = (a: CountRow, b: CountRow) =>
  b.count - a.count || a.label.localeCompare(b.label);

/** The places by base, in the planner's order of bases. */
export function baseRows(ctx: PlannerContext): BaseRow[] {
  return ctx.anchors.map((anchor) => {
    const cities = new Map<string, number>();
    for (const id of anchor.placeIds) {
      const city = ctx.placesById.get(id)?.city;
      if (city) cities.set(city, (cities.get(city) ?? 0) + 1);
    }
    const dayTrips = [...cities]
      .filter(([city]) => city !== anchor.name)
      .map(([city, count]) => ({ label: city, count }))
      .sort(byCountThenName)
      .map(({ label, count }) => ({ city: label, count }));
    return {
      base: anchor.name,
      inCity: cities.get(anchor.name) ?? 0,
      dayTrips,
      total: anchor.placeIds.length,
    };
  });
}

/** How many places of each type, most first: "Historic site 19". */
export function typeRows(places: readonly Place[]): CountRow[] {
  const counts = new Map<string, number>();
  for (const place of places) {
    const label = typeWord(place.type);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort(byCountThenName);
}

export interface HoursCounts {
  listed: number;
  estimated: number; // from words in the listing ("Evenings") or a time of day in the name
  openAccess: number; // public spaces with no set hours
  unknown: number;
}

/** Where the places' hours come from. */
export function hoursCounts(places: readonly Place[]): HoursCounts {
  const counts: HoursCounts = { listed: 0, estimated: 0, openAccess: 0, unknown: 0 };
  for (const place of places) {
    if (place.hoursConfidence === "listed") counts.listed++;
    else if (place.hoursConfidence === "derived") counts.estimated++;
    else if (place.hoursConfidence === "open_access") counts.openAccess++;
    else counts.unknown++;
  }
  return counts;
}

/** "07:00 to 23:00": when a public space with no listed hours is planned. */
export function openAccessHours(): string {
  return `${formatClock(OPEN_ACCESS_WINDOW.open)} to ${formatClock(OPEN_ACCESS_WINDOW.close)}`;
}

/**
 * Every photo's credit, named: a place's photo by the place's name, a city photo as the city's.
 * Places first, then the city photos, each in alphabetical order.
 */
export function creditRows(
  places: readonly Place[],
  credits: readonly PhotoCreditRow[] = photoCredits(),
): CreditRow[] {
  const names = new Map(places.map((place) => [place.id, place.name]));
  const named = credits.map((row) => ({
    ...row,
    name:
      row.kind === "place"
        ? (names.get(row.subject) ?? row.subject)
        : row.kind === "city"
          ? `${row.subject}, city photo`
          : `${typeWord(row.subject as Place["type"])}, general photo`,
  }));
  const order = { place: 0, city: 1, topic: 2 } as const;
  return named.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/**
 * The model the AI planner uses, from the health check, or null. Decision: only a Claude model
 * id is named. A local run with the scripted client reports "fixture", which is not a model, and
 * a planner that is off reports none; the overlay then names no model rather than a guess.
 */
export function plannerModel(health: Pick<Health, "llmAvailable" | "model"> | null): string | null {
  if (!health?.llmAvailable || !health.model) return null;
  return /^claude-[a-z0-9.-]+$/.test(health.model) ? health.model : null;
}

/** "on 25 September 2026", or "between 25 September 2026 and 2 October 2026" over several days. */
export function writtenWhen(record: { firstDay: string | null; lastDay: string | null }): string {
  const { firstDay, lastDay } = record;
  if (!firstDay || !lastDay) return "";
  if (firstDay === lastDay) return `on ${calendarDate(firstDay)}`;
  return `between ${calendarDate(firstDay)} and ${calendarDate(lastDay)}`;
}
