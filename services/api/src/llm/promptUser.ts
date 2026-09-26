import {
  earliestMealStart,
  type Meal,
  PACE,
  type PlannerContext,
  servesMeal,
  TRIP_DAYS,
  type TripRequest,
  transferMinutes,
  weekdayOf,
} from "@italy/planner";
import type { AnchorOption, Candidate, DayStatus, Shortlist } from "../plan/candidates";
import { escapeNotes, oneLine, SCARCE_MEALS } from "./prompt";

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

/** What the Budget line adds when some meal places are offered one price level over it. */
export const OVER_BUDGET_NOTE =
  " (meal places marked over budget are one level over: use one only for a meal no meal place within budget can take)";

/** The must-include ids, each with the offered base it is listed under: "place_026 (florence)". */
// Decision: the base is named because with the meal rules of v3 the model planned the two-city
// eval (the Borghese Gallery in Rome, the Uffizi in Florence) all in Rome in 7 of 9 first answers,
// 3 of 4 of them after rule 9 said "at the base it is listed under", against 0 of 4 with v2. With
// the base named, 5 of 5 put the Uffizi on a Florence day, and the other 10 must-include shapes of
// the failure hunt and the prover all passed on their first answer.
function mustIncludeList(shortlist: Shortlist): string {
  const baseOf = (id: string) =>
    shortlist.options.find((o) => o.candidates.some((c) => c.place.id === id))?.anchor.id;
  const ids = shortlist.mustInclude.map((id) => {
    const base = baseOf(id);
    return base === undefined ? id : `${id} (${base})`;
  });
  return idList(ids);
}

function preferencesSection(request: TripRequest, shortlist: Shortlist): string[] {
  const pace = PACE[request.pace];
  const overBudget = shortlist.options.some((o) => o.candidates.some((c) => c.overBudget));
  const budget =
    request.maxPriceLevel === null
      ? "any price"
      : `up to ${"€".repeat(request.maxPriceLevel)}${overBudget ? OVER_BUDGET_NOTE : ""}`;
  const lines = [
    `Pace: ${request.pace}, at most ${pace.maxVisits} visits a day, not counting meals (fewer is fine)`,
    `Interests: ${request.interests.length === 0 ? "none given" : request.interests.join(", ")}`,
    `Budget: ${budget}`,
    `Must include: ${mustIncludeList(shortlist)}`,
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
 * `days` is the status on each trip day, or `status` when given (one day's hours, dayPrompt.ts).
 */
export function candidateLine(candidate: Candidate, ctx: PlannerContext, status?: string): string {
  const { place } = candidate;
  const area = place.neighborhood ?? place.city;
  const meal = candidate.meal ? `meal: ${place.meals.join(" and ")}` : "not a meal place";
  const notes: string[] = [];
  if (candidate.mustInclude) notes.push("must include");
  if (candidate.overBudget) notes.push("over budget, meals only");
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
    status ?? candidate.statuses.map(statusText).join("; "),
    notes.join("; ") || "-",
  ].join(" | ");
}

/** The meal places of a base that can take this meal on this date, by their hours. */
export function mealsOpen(option: AnchorOption, date: string, meal: Meal): string[] {
  return option.candidates
    .filter(
      (c) =>
        c.meal &&
        servesMeal(c.place, meal) &&
        earliestMealStart(c.place, date, 0, meal, c.place.durationMin) !== null,
    )
    .map((c) => c.place.id);
}

/**
 * The base's meal supply, under its header: how many meal places it offers, and how many can take
 * lunch and dinner on each trip day, named on a scarce day: SCARCE_MEALS or fewer, and fewer than
 * on another day of the trip.
 */
// Decision: the counts are stated, and the places named on a scarce day, because the model
// writes every day at once and cannot work out hours. Rome from a Friday offers 7 meal places,
// but only 2 can take lunch on the Sunday: with v2, 15 of 37 such live Sundays had lunch, and
// with v3 13 of 20. In 145 live plans of 2026-09-25 (v2) the model wrote 1.41 meal places a day
// where its bases could hold 1.66, and 187 of 435 answer days had a single one. On the same 12
// request shapes, counts alone raised that to 1.44 and counts with the named places to 1.58 (1.23
// with v2), and over 69 shapes v3 plans have 1.48 lunches and dinners a day against 1.27.
export function mealSupplyLine(option: AnchorOption, dates: readonly string[]): string {
  const total = option.candidates.filter((c) => c.meal).length;
  const perDay = (meal: Meal) => {
    const open = dates.map((date) => mealsOpen(option, date, meal));
    const most = Math.max(...open.map((ids) => ids.length));
    return open
      .map((ids, day) => {
        const scarce = ids.length > 0 && ids.length <= SCARCE_MEALS && ids.length < most;
        return `${DAY_KEYS[day]} ${ids.length}${scarce ? ` (${ids.join(", ")})` : ""}`;
      })
      .join(", ");
  };
  return `Meal supply: ${total} meal places, each used once in the trip. Lunch: ${perDay("lunch")}. Dinner: ${perDay("dinner")}.`;
}

function candidatesSection(shortlist: Shortlist, ctx: PlannerContext): string[] {
  const lines = [
    `Candidates by base (id | name | type | area | tags | rating | price | visit length | meal | status on ${DAY_KEYS.join(", ")} | notes):`,
  ];
  for (const option of shortlist.options) {
    lines.push("", `Base ${option.anchor.id}:`, mealSupplyLine(option, shortlist.dates));
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
