import type { Meal, Place, StopRole } from "@italy/planner";
import { typeWord } from "./format";

// The "why" line under a stop, without the sentences the row already prints. Rule-based reasons
// (planner reasons.ts) open with the type and area ("Cafe in Pigna.") and the rating ("Rated 4.3
// out of 5."), which the row shows just above; meal reasons open with "Dinner at a restaurant
// in Trastevere", which the meal label and subtitle already say. Only exact copies of those
// sentences are removed, rebuilt from the place's own data, so a change in the planner's wording
// can only make the line longer again, never drop a sentence that says something new. AI
// reasons are free text and are left alone.

/** Types a meal reason names as the venue ("Lunch at a market in Testaccio"). */
const MEAL_VENUE_TYPES: readonly Place["type"][] = ["restaurant", "cafe", "market", "shop"];

const CLOSE = "close to your previous stop";

export interface ReasonContext {
  place: Place | undefined;
  role: StopRole;
  ratingShown: boolean; // the row prints the rating, so "Rated 4.3 out of 5." is a repeat
  coveredMeals?: readonly Meal[]; // the row says "Lunch during this visit"
}

/** The planner's sentence cleanup: control characters and runs of spaces become one space. */
function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The planner's area rule: the neighborhood when known, the city for neighborhoods. */
function areaOf(place: Place): string {
  return place.type === "neighborhood" || place.neighborhood === null
    ? place.city
    : place.neighborhood;
}

function coveredSentence(meals: readonly Meal[]): string | null {
  if (meals.length === 0) return null;
  if (meals.length > 1) return "Lunch and dinner are part of this outing.";
  return `${capitalize(meals[0] as string)} is part of this outing.`;
}

/** Exact sentences to drop because the row already shows them. */
function repeats(context: ReasonContext): string[] {
  const { place, role } = context;
  // The planner's fallbacks: "Suggested stop." says nothing, "Lunch stop." repeats the label.
  const fallback = role === "visit" ? "Suggested stop." : `${capitalize(role)} stop.`;
  if (!place) return [fallback];
  const words = typeWord(place.type).toLowerCase();
  const area = areaOf(place);
  const out = [fallback, clean(`${capitalize(words)} in ${area}.`)];
  if (context.ratingShown && place.rating !== null && Number.isFinite(place.rating)) {
    out.push(`Rated ${Number(place.rating.toFixed(1))} out of 5.`);
  }
  if (role !== "visit") {
    const venue = MEAL_VENUE_TYPES.includes(place.type) ? ` at a ${words}` : "";
    const lead = clean(`${capitalize(role)}${venue} in ${area}`);
    out.push(`${lead}, ${CLOSE}.`, `${lead}.`);
  }
  const covered = coveredSentence(context.coveredMeals ?? []);
  if (covered) out.push(covered);
  return out;
}

/**
 * The reason to show, or null when nothing new is left. `ai` reasons come back unchanged.
 * "Dinner at a restaurant in Trastevere, close to your previous stop." keeps its news as
 * "Close to your previous stop."
 */
export function displayReason(
  reason: string | undefined,
  ai: boolean,
  context: ReasonContext,
): string | null {
  if (!reason) return null;
  if (ai) return reason;
  let text = ` ${clean(reason)} `;
  for (const sentence of repeats(context)) {
    const at = text.indexOf(` ${sentence} `);
    if (at === -1) continue;
    const replacement = sentence.endsWith(`, ${CLOSE}.`) ? ` ${capitalize(CLOSE)}. ` : " ";
    text = text.slice(0, at) + replacement + text.slice(at + sentence.length + 2);
  }
  const left = text.trim();
  return left === "" ? null : left;
}
