import { FREE_TEXT_HOURS, MIN_SUGGEST_RATING, OPEN_ACCESS_WINDOW } from "../config";
import { formatClock } from "../time";
import type { IssueKind, TimeRange } from "../types";
import { CLEANUP_ISSUE_TEXT } from "./issueTextCleanup";

// Plain-language text for every issue kind, used by the "About this data" panel and the audit.
// The order of this table is the display order: what changes a traveler's plan comes first.
// Adding an issue kind to ISSUE_KINDS without a row here is a type error. Policy numbers come
// from config, so the panel never disagrees with what the planner does.

const span = (window: TimeRange) => `${formatClock(window.open)} to ${formatClock(window.close)}`;
const freeTextWindows = FREE_TEXT_HOURS.map((rule) => `${rule.label} ${span(rule.window)}`).join(
  ", ",
);

type IssueText = { title: string; explanation: string };

/** First part of the table, in display order: closures, hours, notes, location, meals, price. */
const PLAN_ISSUE_TEXT = {
  note_unread: {
    title: "Notes that may limit dates, not yet read",
    explanation:
      "A source note looks like it limits when the place is open, but its wording is not recognized. It is shown with the place and flagged for review.",
  },
  place_closed: {
    title: "Closed places",
    explanation: "The hours or a note say the place is closed, so it is left out of plans.",
  },
  hours_missing: {
    title: "Hours not confirmed",
    explanation:
      "No opening hours are listed. These places can still be planned, but rank lower and carry a warning.",
  },
  hours_unparsed: {
    title: "Hours not readable",
    explanation: "The listed hours could not be read, so they are treated as not confirmed.",
  },
  hours_open_access: {
    title: "Public spaces with no set hours",
    explanation: `Squares, fountains, bridges, parks, and viewpoints with no listed hours are treated as open from ${span(OPEN_ACCESS_WINDOW)}.`,
  },
  hours_free_text: {
    title: "Hours estimated from the listing",
    explanation: `Hours such as "Evenings" or "Morning only" are turned into an estimated window (${freeTextWindows}).`,
  },
  hours_name_hint: {
    title: "Hours estimated from the name",
    explanation:
      'Places named "by Night", "at Dawn", "Early Morning", or "Aperitivo" are only planned at that time of day.',
  },
  season_restriction: {
    title: "Open part of the year",
    explanation:
      "A source note says the place is open only in some months. It is never planned outside them.",
  },
  date_restriction: {
    title: "Open some days only",
    explanation:
      "A source note limits the place to certain days, such as weekdays. It is never planned on other days.",
  },
  hours_conflict: {
    title: "Hours conflict in source, using the stricter one",
    explanation:
      "The listed hours and a source note disagree. The plan follows the stricter of the two.",
  },
  note_not_applied: {
    title: "Notes that would extend hours",
    explanation:
      "Notes such as longer summer hours are shown but not used: a wrong open time could waste a visit, so notes only ever narrow the hours.",
  },
  hours_past_midnight: {
    title: "Closes after midnight",
    explanation: "Closing times after midnight are kept as late closings on the same day.",
  },
  low_rating: {
    title: "Low ratings",
    explanation: `Places rated below ${MIN_SUGGEST_RATING} are never suggested, but you can still add them yourself.`,
  },
  coords_far_from_city: {
    title: "Approximate location",
    explanation:
      "The listed coordinates are far from the place's city, so the place is shown at the middle of its neighborhood or city instead.",
  },
  coords_missing: {
    title: "Missing location",
    explanation:
      "No usable coordinates are listed, so the location is estimated from nearby places in the same city.",
  },
  coords_out_of_bounds: {
    title: "Location outside Italy",
    explanation:
      "The coordinates point outside Italy, so the location is estimated from nearby places in the same city.",
  },
  coords_swapped: {
    title: "Swapped coordinates",
    explanation:
      "Latitude and longitude were listed the wrong way round and have been swapped back.",
  },
  coords_unrepairable: {
    title: "No usable location",
    explanation:
      "These places have no usable coordinates and nothing nearby to estimate from, so they are left out of plans.",
  },
  shared_location: {
    title: "Same spot, different experience",
    explanation:
      "Two listings share one location (such as a fountain by day and by night). A trip includes at most one of them.",
  },
  same_experience: {
    title: "Same experience, listed twice",
    explanation:
      "Two listings describe the same visit (a tasting and the producer it recommends). A trip includes at most one of them.",
  },
  duration_missing: {
    title: "Estimated visit time",
    explanation: "No visit length is listed, so a typical length for the type of place is used.",
  },
  duration_out_of_bounds: {
    title: "Visit time adjusted",
    explanation:
      "The listed visit length is outside the usual range for its type and has been brought into range.",
  },
  duration_exceeds_hours: {
    title: "Visit time shortened to fit the hours",
    explanation:
      "The listed visit is longer than the place is ever open in one stretch, so it is shortened to fit.",
  },
  meal_unavailable: {
    title: "Meals the hours do not allow",
    explanation:
      "A restaurant open only in the evening is not offered for lunch, and one open only at midday is not offered for dinner.",
  },
  duration_format: {
    title: "Visit time given as text",
    explanation: "Visit lengths written as text were converted to minutes.",
  },
  duration_invalid: {
    title: "Visit time not usable",
    explanation: "The listed visit length is not a positive number, so a typical length is used.",
  },
  price_conflict: {
    title: "Price and tags disagree",
    explanation:
      "A place tagged free, budget, or splurge has a listed price that says otherwise. The listed price is used; free and the lowest price count the same.",
  },
  price_missing: {
    title: "Price unknown",
    explanation: "No price is listed. These places pass every budget filter.",
  },
  price_unparsed: {
    title: "Price not readable",
    explanation: "The listed price could not be read, so it is treated as unknown.",
  },
  price_format: {
    title: "Price in another format",
    explanation: "Prices written as numbers, $ signs, or words were converted to price levels.",
  },
} satisfies Partial<Record<IssueKind, IssueText>>;

export const ISSUE_KIND_TEXT: Record<IssueKind, IssueText> = {
  ...PLAN_ISSUE_TEXT,
  ...CLEANUP_ISSUE_TEXT,
};
