import type { TripRequest } from "@italy/planner";
import { type TripFormValues, valuesFromRequest } from "./tripForm";
import type { InterestOption } from "./tripOptions";

// The options folded away behind "More options": which of them the traveler has set (the count
// on the button and in the trip summary), clearing them in one step, and which interest chips
// show before "Show all interests". Start date and pace are never options: they are always on
// screen, so they never count and are never cleared.

export type OptionGroup = "interests" | "budget" | "bases" | "mustInclude" | "exclude" | "notes";

/** Interest chips shown before "Show all interests": the most common ones. */
export const INTERESTS_SHOWN = 8;

/** The option groups that differ from their defaults, in the order the panel lists them. */
export function setOptionGroups(values: TripFormValues): OptionGroup[] {
  const groups: OptionGroup[] = [];
  if (values.interests.length > 0) groups.push("interests");
  if (values.maxPriceLevel !== null) groups.push("budget");
  // Decision: choosing bases counts as set even before a base is picked. The traveler changed
  // it, and the form's error for "no base picked" lives inside the panel the count points to.
  if (values.anchorMode === "choose") groups.push("bases");
  if (values.mustInclude.length > 0) groups.push("mustInclude");
  if (values.exclude.length > 0) groups.push("exclude");
  if (values.notes.trim() !== "") groups.push("notes");
  return groups;
}

/** How many option groups are set. A group counts once however many chips it has picked. */
export function optionCount(values: TripFormValues): number {
  return setOptionGroups(values).length;
}

/** The same count for a request that was sent, such as the plan on screen. */
export function requestOptionCount(request: TripRequest): number {
  return optionCount(valuesFromRequest(request));
}

/** The values with every option back to its default. Start date and pace stay as they are. */
export function clearOptions(values: TripFormValues): TripFormValues {
  return {
    ...values,
    interests: [],
    maxPriceLevel: null,
    anchorMode: "auto",
    anchors: [],
    mustInclude: [],
    exclude: [],
    notes: "",
  };
}

/** The badge on the button: "2 set", or null when nothing is set. */
export function setBadgeText(count: number): string | null {
  return count > 0 ? `${count} set` : null;
}

/** The disclosure button's full name: "More options" or "More options, 2 set". */
export function moreOptionsName(count: number): string {
  const badge = setBadgeText(count);
  return badge ? `More options, ${badge}` : "More options";
}

/** Interests from most to least common; ties keep the order they came in. */
function mostCommonFirst(interests: readonly InterestOption[]): InterestOption[] {
  return interests
    .map((interest, index) => ({ interest, index }))
    .sort((a, b) => b.interest.count - a.interest.count || a.index - b.index)
    .map(({ interest }) => interest);
}

/**
 * The interest chips to show. Folded, the most common `shown`, plus any picked interest outside
 * them, so a choice restored from a shared link or a saved plan is never hidden.
 */
export function visibleInterests(
  interests: readonly InterestOption[],
  selected: readonly string[],
  showAll: boolean,
  shown: number = INTERESTS_SHOWN,
): InterestOption[] {
  const sorted = mostCommonFirst(interests);
  if (showAll) return sorted;
  return sorted.filter((interest, index) => index < shown || selected.includes(interest.tag));
}
