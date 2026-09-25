import {
  PACE,
  type PlannerContext,
  TRIP_DAYS,
  type TripRequest,
  transferMinutes,
  weekdayOf,
} from "@italy/planner";
import type { Candidate, DayStatus, Shortlist } from "../plan/candidates";
import { escapeNotes, oneLine } from "./prompt";

// The user message: trip dates, preferences, base options, candidates grouped by base, then the
// traveler's notes. Only facts from the data and the validated request go in; nothing here is
// free text from the traveler except the escaped notes at the very end.

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The short names the candidate rows give the trip days: d1, d2, d3. */
export const DAY_KEYS = Array.from({ length: TRIP_DAYS }, (_, index) => `d${index + 1}`);

export const weekdayName = (date: string): string => WEEKDAY_NAMES[weekdayOf(date)] ?? "";

function datesSection(dates: readonly string[]): string[] {
  const lines = ["Trip dates:"];
  dates.forEach((date, index) => {
    lines.push(`- Day ${index + 1} (d${index + 1}): ${date} (${weekdayName(date)})`);
  });
  return lines;
}

function idList(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

function preferencesSection(request: TripRequest, shortlist: Shortlist): string[] {
  const pace = PACE[request.pace];
  const budget =
    request.maxPriceLevel === null ? "any price" : `up to ${"€".repeat(request.maxPriceLevel)}`;
  const lines = [
    `Pace: ${request.pace}, at most ${pace.maxVisits} visits a day, not counting meals (fewer is fine)`,
    `Interests: ${request.interests.length === 0 ? "none given" : request.interests.join(", ")}`,
    `Budget: ${budget}`,
    `Must include: ${idList(shortlist.mustInclude)}`,
    `Excluded: ${idList(request.exclude)}`,
  ];
  if (shortlist.unplaceable.length > 0) {
    lines.push(
      `Must-include places that cannot be placed on these dates or bases (leave them out): ${idList(shortlist.unplaceable)}`,
    );
  }
  return lines;
}

function anchorsSection(shortlist: Shortlist): string[] {
  const lines = ["Base options (id | name | region | transfer minutes to other options):"];
  for (const { anchor } of shortlist.options) {
    const transfers = shortlist.options
      .filter((other) => other.anchor.id !== anchor.id)
      .map((other) => `${other.anchor.id} ${transferMinutes(anchor, other.anchor)}`);
    const transferText = transfers.length === 0 ? "none" : transfers.join(", ");
    lines.push(
      `${anchor.id} | ${oneLine(anchor.name)} | ${oneLine(anchor.region)} | ${transferText}`,
    );
  }
  return lines;
}

function statusText(status: DayStatus, index: number): string {
  const day = `d${index + 1}`;
  if (status.kind === "open") return `${day} open ${status.ranges}`;
  if (status.kind === "closed") return `${day} closed`;
  return `${day} hours unknown`;
}

/**
 * One candidate row:
 * id | name | type | area | tags | rating | price | visit minutes | meal | days | notes
 */
export function candidateLine(candidate: Candidate, ctx: PlannerContext): string {
  const { place } = candidate;
  const area = place.neighborhood ?? place.city;
  const meal = candidate.meal ? `meal: ${place.meals.join(" and ")}` : "not a meal place";
  const notes: string[] = [];
  if (candidate.mustInclude) notes.push("must include");
  const sameSpot = place.sharedLocationWith.filter((id) => ctx.placesById.has(id));
  if (sameSpot.length > 0) notes.push(`same spot as ${sameSpot.join(", ")}`);
  return [
    place.id,
    oneLine(place.name),
    place.type,
    oneLine(area),
    place.tags.join(", ") || "no tags",
    place.rating === null ? "no rating" : place.rating.toFixed(1),
    place.priceLevel === null ? "price unknown" : "€".repeat(place.priceLevel),
    `${place.durationMin} min`,
    meal,
    candidate.statuses.map(statusText).join("; "),
    notes.join("; ") || "-",
  ].join(" | ");
}

function candidatesSection(shortlist: Shortlist, ctx: PlannerContext): string[] {
  const lines = [
    `Candidates by base (id | name | type | area | tags | rating | price | visit length | meal | status on ${DAY_KEYS.join(", ")} | notes):`,
  ];
  for (const option of shortlist.options) {
    lines.push("", `Base ${option.anchor.id}:`);
    for (const candidate of option.candidates) lines.push(candidateLine(candidate, ctx));
  }
  return lines;
}

/** The full user message, in the plan's order. */
export function buildUserMessage(
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
): string {
  const sections = [
    datesSection(shortlist.dates),
    preferencesSection(request, shortlist),
    anchorsSection(shortlist),
    candidatesSection(shortlist, ctx),
  ];
  const notes = request.notes === undefined ? "" : escapeNotes(request.notes);
  if (notes !== "") sections.push(["<traveler_notes>", notes, "</traveler_notes>"]);
  return sections.map((lines) => lines.join("\n")).join("\n\n");
}
