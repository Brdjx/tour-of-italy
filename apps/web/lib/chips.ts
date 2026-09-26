import {
  formatClock,
  type Meal,
  type MealGap,
  type MealGapPlace,
  OPEN_ACCESS_WINDOW,
  type Place,
  type PlaceNoteKind,
  placeNotes,
  type Violation,
  type ViolationCode,
} from "@italy/planner";

// Chips: one short label per fact the traveler should know about a stop or a day, each with a
// plain explanation shown on tap or focus. Data notes come from the planner's placeNotes (so
// the wording matches the API and the data panel); plan warnings and errors come from the
// validator's violations, whose own detail sentence is the explanation.

export type ChipTone = "note" | "warning" | "error";

/** A place an explanation names, and why it cannot help when that is not the same for all. */
export interface ChipPlace {
  name: string;
  why: string | null; // "closed on Mondays", "on day 1"; null when the sentence says it for all
}

/** A way out the explanation offers as a control: "city" chooses another city for the day. */
export type ChipAction = "city";

export interface Chip {
  key: string; // stable React key
  label: string; // short, sentence case
  explanation: string; // what it means and what to do (with `wayOut`, what it means)
  tone: ChipTone;
  places?: ChipPlace[]; // the places the explanation is about, listed under it
  wayOut?: string; // what to do, when it follows the places; `action` is the same as a control
  action?: ChipAction;
}

const NOTE_EXPLANATIONS: Record<PlaceNoteKind, string> = {
  hours_unknown: "The source lists no opening hours. Check them before you go.",
  hours_estimated:
    "The listing gives hours in words, such as Evenings, so the planner uses an estimated window. Check before you go.",
  open_access: `A public space with no set hours. It is planned between ${formatClock(OPEN_ACCESS_WINDOW.open)} and ${formatClock(OPEN_ACCESS_WINDOW.close)}.`,
  season: "Open only part of the year. It is never planned outside those months.",
  date_rule: "Open only on some days. It is never planned on the other days.",
  hours_conflict:
    "The source gives two different sets of hours. The planner uses the stricter one.",
  estimated_duration:
    "The source gives no visit length, so a typical time for this kind of place is used.",
  approximate_location:
    "The listed location looked wrong, so the map shows an estimate near the neighborhood.",
  price_unknown: "The source gives no price for this place.",
  book_ahead: "Booking is required or strongly advised. Book before you go.",
};

const CODE_LABELS: Record<ViolationCode, string> = {
  WRONG_DAY_COUNT: "Wrong number of days",
  WRONG_DATE: "Wrong date",
  UNKNOWN_ANCHOR: "Unknown base",
  TOO_MANY_ANCHORS: "Too many bases",
  UNKNOWN_PLACE: "Not in the data",
  DUPLICATE_PLACE: "Already in your trip",
  EXCLUDED_PLACE: "On your skip list",
  EMPTY_DAY: "Empty day",
  INVALID_TIME: "Time does not work",
  CLOSED_AT_TIME: "Closed at this time",
  SEASONAL_CLOSED: "Closed on this date",
  OVERLAP: "Not enough time to get here",
  WRONG_TRAVEL: "Travel time does not match",
  OUTSIDE_DAY_WINDOW: "Outside your day",
  OUTSIDE_ANCHOR: "Too far from this day's base",
  TOO_MANY_VISITS: "Too many visits for your pace",
  MEAL_OUTSIDE_WINDOW: "Outside meal times",
  NOT_A_MEAL_PLACE: "Not a place to eat",
  MUST_INCLUDE_MISSING: "Must-see left out",
  MUST_INCLUDE_UNPLACEABLE: "Must-see does not fit",
  HOURS_UNKNOWN: "Hours not confirmed",
  OVER_BUDGET: "Above your budget",
  MEAL_MISSING: "Meal missing",
  LONG_TRANSFER: "Long transfer",
  SAME_LOCATION: "Same spot as another stop",
  LOW_RATING: "Low rating",
  ANCHOR_NOT_CHOSEN: "Not one of your bases",
};

/** Short chip label for a violation code. */
export function violationLabel(code: ViolationCode): string {
  return CODE_LABELS[code] ?? "Check this stop";
}

/**
 * What to do about a warning. The detail says what is wrong; this says the next step. Codes
 * whose detail already says what to do (HOURS_UNKNOWN: "check before you go") have none.
 */
export const WARNING_NEXT_STEP: Partial<Record<ViolationCode, string>> = {
  MEAL_MISSING: "Swap a stop near that meal time for a place to eat, or undo your last change.",
  LONG_TRANSFER: "Bases closer together, or one base, leave more time to visit.",
  OVER_BUDGET: "Swap it for a cheaper place, or raise your budget.",
  SAME_LOCATION: "Swap one of them to see somewhere new.",
  LOW_RATING: "Swap it for a better-rated place if you prefer.",
  MUST_INCLUDE_UNPLACEABLE: "Try other dates or another pace, or take it off your must-see list.",
  ANCHOR_NOT_CHOSEN: "Edit the trip to change your bases.",
};

const ERROR_NEXT_STEP = "Undo the last change, or swap or remove this stop.";

export function violationChip(violation: Violation, index = 0): Chip {
  const tone: ChipTone = violation.severity === "error" ? "error" : "warning";
  const next = tone === "error" ? ERROR_NEXT_STEP : WARNING_NEXT_STEP[violation.code];
  return {
    key: `${violation.code}-${violation.placeId ?? ""}-${index}`,
    label: violationLabel(violation.code),
    explanation: next ? `${violation.detail} ${next}` : violation.detail,
    tone,
  };
}

/** The meal a MEAL_MISSING warning is about, from its detail ("Day 3 has no dinner stop."). */
export function missingMeal(violation: Pick<Violation, "detail">): Meal | null {
  const found = /\bno (lunch|dinner) stop\b/i.exec(violation.detail)?.[1];
  return found ? (found.toLowerCase() as Meal) : null;
}

/**
 * The chip for a lunch or dinner a day does not have, by why (decision 17, dayMealGaps): "No
 * dinner open" when no place of the city can take it that date, with the places and why, and the
 * way out another city for the day; "No dinner planned" when one could, with the planner's
 * sentence for who could and a swap when a place not in the trip and within the budget could
 * (named under it when there are several), else another city, with the day that has each place.
 * Without its gap (a plan the planner cannot read), the validator's words.
 */
// Decision: the way out follows the cause (the owner, 2026-09-26: "ai missed a meal for day 3",
// a Monday in Bologna, where the chip said to swap a stop near that meal time and no swap could
// give the day a dinner). A chip never offers a swap that cannot work: when every place that
// could take the meal is on another day or over the budget, the swap sheet has none to offer.
export function mealChip(violation: Violation, gap: MealGap | undefined, index = 0): Chip {
  const base = violationChip(violation, index);
  if (!gap) return base;
  const { meal } = gap;
  if (gap.text === "") return { ...base, label: `No ${meal} planned` };
  if (gap.cause === "none_open") {
    const reasons = new Set(gap.places.map((place) => place.why));
    const shared = reasons.size < 2;
    return {
      ...base,
      label: `No ${meal} open`,
      explanation: gap.text,
      places: gap.places.map((place) => ({ name: place.name, why: shared ? null : place.why })),
      wayOut: `Choose another city for this day to have ${meal} in the plan.`,
      action: "city",
    };
  }
  const label = `No ${meal} planned`;
  const free = gap.places.filter(swappable);
  const next = `Swap a stop near ${meal} time for a place to eat, or undo your last change.`;
  // One place is named in the sentence; several are counted there and named under it.
  if (free.length === 1) return { ...base, label, explanation: `${gap.text} ${next}` };
  if (free.length > 1) {
    const places = free.map((place) => ({ name: place.name, why: null }));
    return { ...base, label, explanation: gap.text, places, wayOut: next };
  }
  // The places that could take it, each with the day it is on; "over your budget" only beside
  // places on a day, since the sentence says it when it is true of them all.
  const could = gap.places.filter((place) => place.block === null);
  const held = could.some((place) => place.day !== null);
  return {
    ...base,
    label,
    explanation: gap.text,
    places: could.map((place) => ({ name: place.name, why: heldWhy(place, held) })),
    wayOut: "Choose another city for this day, or undo your last change.",
    action: "city",
  };
}

/** A place a swap on the day could bring in: it can take the meal, is free and within budget. */
function swappable(place: MealGapPlace): boolean {
  return place.block === null && place.day === null && !place.overBudget;
}

/** Why a place that could take the meal is no way to it: the day that has it, or its price. */
function heldWhy(place: MealGapPlace, held: boolean): string | null {
  if (place.day !== null) return `on day ${place.day + 1}`;
  return held ? "over your budget" : null;
}

/**
 * Chips for a day's own violations (violationsForDay), a missing lunch or dinner by its cause
 * (`gaps`: the day's dayMealGaps).
 */
export function dayChips(violations: readonly Violation[], gaps: readonly MealGap[]): Chip[] {
  return violations.map((violation, index) => {
    if (violation.code !== "MEAL_MISSING") return violationChip(violation, index);
    const meal = missingMeal(violation);
    const gap = gaps.find((one) => one.day === violation.day && one.meal === meal);
    return mealChip(violation, gap, index);
  });
}

/** Chips for a stop: errors first, then plan warnings, then data notes, without repeats. */
export function stopChips(place: Place | undefined, violations: readonly Violation[]): Chip[] {
  const chips = violations.map((violation, index) => violationChip(violation, index));
  chips.sort((a, b) => toneRank(a.tone) - toneRank(b.tone));
  const hasHoursWarning = violations.some((violation) => violation.code === "HOURS_UNKNOWN");
  for (const note of place ? placeNotes(place) : []) {
    // The HOURS_UNKNOWN warning already says "Hours not confirmed" with the day's detail.
    if (note.kind === "hours_unknown" && hasHoursWarning) continue;
    chips.push({
      key: `note-${note.kind}-${note.label}`,
      label: note.label,
      explanation: NOTE_EXPLANATIONS[note.kind],
      tone: "note",
    });
  }
  return chips;
}

function toneRank(tone: ChipTone): number {
  return tone === "error" ? 0 : tone === "warning" ? 1 : 2;
}

/** Violations that point at one stop. */
export function violationsForStop(
  violations: readonly Violation[],
  day: number,
  stopIndex: number,
): Violation[] {
  return violations.filter((item) => item.day === day && item.stopIndex === stopIndex);
}

/** How many stops have an error on them: the rows the board marks as flagged. */
export function flaggedStopCount(violations: readonly Violation[]): number {
  const stops = new Set<string>();
  for (const item of violations) {
    if (item.severity !== "error" || item.day === undefined || item.stopIndex === undefined) {
      continue;
    }
    stops.add(`${item.day}:${item.stopIndex}`);
  }
  return stops.size;
}

/** Violations about a whole day, not one stop. */
export function violationsForDay(violations: readonly Violation[], day: number): Violation[] {
  return violations.filter((item) => item.day === day && item.stopIndex === undefined);
}

/** Violations about the whole trip (no day). */
export function tripViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter((item) => item.day === undefined);
}
