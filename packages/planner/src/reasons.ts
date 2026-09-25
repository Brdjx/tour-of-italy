import { REASON_MAX_CHARS } from "./config";
import { coversMeal, isOpenDuring } from "./constraints";
import { closedForHoliday } from "./dayRules";
import { EVENING_FROM } from "./planPolicy";
import { addDays, type OpenStatus, openStatusOn, WEEKDAY_LONG, weekdayOf } from "./time";
import { type LatLng, travelMode } from "./travel";
import type { IssueKind, Meal, Place, StopRole, TripRequest } from "./types";

// Rule-based reasons: one short line per stop, built only from the place's own data, the request,
// and the stop's own day. Used by the deterministic planner, and in place of any AI reason the API
// drops. The caller sets reasonSource: "rule". The page reads the line out as "Why, from the
// rules:". Most of it is why the rules picked the stop (the request, the tags and rating the score
// rewards) or what the stop's date and times mean for it; one sentence is neither, the listing's
// time-of-day tag, which moves no score (TIME_OF_DAY_TAGS says how it is kept apart).
// Decision: rule reasons never contain clock times, durations, prices, or another place's name,
// so they pass the same sanitizer as AI reasons and can never be dropped in a loop
// (services/api/test/unit/ruleReasons.test.ts holds every sentence to that check).
// Decision: a rule reason never opens with what the row above it prints: the meal label, the
// type and the area ("Dinner in Ostiense.", "Museum in Borgo." are gone). What it says is the
// request (asked for, interests), what the stop's date means for it, the tags the score rewards,
// worded as what the data lists ("Listed as a local favorite.", never "A local favorite." as if
// it were our opinion), the day's highest rating, the rating, the listing's time-of-day tag when
// the visit is then, an outing's meal, and for a meal a walk from the previous stop. The page
// drops the sentences its board prints another way (lib/reasonText.ts): the rating on the row,
// the walk on the leg line above it, the outing's meal as the row's label. The swap sheet prints
// none of them, so it keeps them.
// Decision: the date sentences say what the traveler can do on the date ("It cannot be visited
// on Sunday, the trip's last day.", "Starts as it opens."), never the hours themselves. Each is
// the planner's own answer (openStatusOn, isOpenDuring: what the scheduler and the validator
// use) for this stop's date and times, stated as a plain fact: no "so it comes first", because
// the order also depends on the score and the walk, which the line does not show. The sanitizer
// keeps hours out of AI text because the model's version may be wrong; these are computed, and
// their words still pass it ("closes", "open until" and "hours" never appear). "It opens later"
// passes only because the sanitizer's "open late" must end at a word boundary, and "later" goes
// on; services/api/test/unit/ruleReasons.test.ts runs the real check over that sentence, so a
// tighter pattern fails that test instead of going unnoticed.
// Decision: no walk sentence for a visit. The board prints the leg above every row ("12 min
// walk"), so on most rows it would repeat the line above it. A meal keeps its sentence for the
// swap sheet, which prints no leg; the board drops it (lib/reasonText.ts, legShown).
// Decision: no day-level dedupe. A line is read beside its own row, alone in the swap sheet, and
// stop by stop by a screen reader, so a true sentence stays even when another stop says it too;
// dropping it could leave a row with no line at all. Over 2,700 rules-only days (10 dates, 3
// paces, 5 interest sets, each base and automatic), 37 of those with three or more stops have a
// sentence other than the request's on every stop, and the days whose board (as the page shows
// it) repeats a line fell from 2,058 before the date sentences to 976.

/** Said when nothing new is left. The page hides these; the field is never empty. */
const FALLBACK: Record<StopRole, string> = {
  visit: "Suggested stop.",
  lunch: "Lunch stop.",
  dinner: "Dinner stop.",
};

/** Most matched interests named in one reason, so the sentence stays short. */
const MAX_NAMED_INTERESTS = 3;

/**
 * Tags the score rewards on their own (score.ts), in the order a reason names them, with the
 * words after "Listed as".
 */
// Decision: only these two. They are why the rules rank a place without any interest chosen, so
// naming them is the honest answer to "why this stop". Other tags (hidden gem, romantic) move no
// score and would read as a recommendation the planner never made. The one exception, the
// time-of-day tag, is never joined to these: see TIME_OF_DAY_TAGS.
const LISTED_TAGS: readonly { tag: string; words: string }[] = [
  { tag: "iconic", words: "iconic" },
  { tag: "local-favorite", words: "a local favorite" },
];

/** The morning ends here, minutes from midnight (12:00). */
export const MORNING_ENDS = 12 * 60;

/** The evening starts here: the planner's own EVENING_FROM (18:00). */
export const EVENING_STARTS = EVENING_FROM;

/**
 * The time-of-day tags a visit's line names, each only when at least half the visit is in that
 * part of the day: its midpoint at or before MORNING_ENDS for "morning", at or after
 * EVENING_STARTS for "evening".
 */
// Decision: the data tags places "morning" and "evening" (config.ts keeps them out of the
// interests because they describe a time of day). The score does not read these tags, so they
// are no reason the rules picked the stop, and the line says so by its form: a sentence of its
// own, worded as the listing's ("The listing calls it an evening place."), after every sentence
// the score stands behind, and only for a visit mostly at that time. A morning place planned at
// 15:15 says nothing, rather than a tag its own times contradict; so does Trastevere from 15:15
// to 18:15, an afternoon that ends in the evening, and a morning market from 11:55 to 13:25.
// Noon and 18:00 because those are the lines the planner already draws: outings and treats turn
// on noon (planPolicy.ts), and EVENING_FROM is where the evening's waits and the evening-only
// places start. Visits only: every dinner is in the evening, so for a meal the tag says nothing.
const TIME_OF_DAY_TAGS: readonly {
  tag: string;
  words: string;
  holds: (midpoint: number) => boolean;
}[] = [
  { tag: "morning", words: "a morning place", holds: (midpoint) => midpoint <= MORNING_ENDS },
  { tag: "evening", words: "an evening place", holds: (midpoint) => midpoint >= EVENING_STARTS },
];

/**
 * A visit that starts at most this many minutes after the place opens "starts soon after it
 * opens". Only for listed hours: an estimate or a public space has no opening to be soon after.
 */
// Decision: 60 minutes. A balanced day starts at 09:30 (config.ts PACE), and the ride to the
// first stop comes on top, so its first visit starts 35 to 50 minutes after a 09:00 opening (the
// Pantheon at 09:35, the Colosseum at 09:50). A relaxed day starts at 10:00, so its first visit
// is more than an hour after a 09:00 opening; a packed day starts at 08:30 and waits for the
// place to open. The Borghese Gallery at 10:50 is well into its day. Visits only: lunch 50 minutes after a
// restaurant opens is an ordinary lunch, while a dinner that starts exactly as the restaurant
// opens is said ("Starts as it reopens.") because that is what sets its time.
export const SOON_AFTER_OPENING_MIN = 60;

/**
 * Issue kinds that mean the listing says more about when the place is open than the planner's
 * hours hold: a note it did not apply, or a note it read over the listed hours.
 */
const UNSETTLED_HOURS: readonly IssueKind[] = ["note_not_applied", "note_unread", "hours_conflict"];

/** Ordinal words for a day of the trip, by index. The last day is always "last". */
const DAY_ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];

/** The place fields a reason reads. */
export type ReasonPlace = Pick<
  Place,
  | "id"
  | "type"
  | "rating"
  | "tags"
  | "lat"
  | "lng"
  | "hours"
  | "hoursConfidence"
  | "dateRules"
  | "issues"
  | "mealCapable"
  | "durationMin"
>;

/** Every day of the trip (date and base, in order) and which one the stop is on. */
export interface TripDays {
  days: readonly { date: string; anchorId: string }[];
  index: number;
}

/** The stop in its day: what the sentences about this stop on this date read. */
export interface ReasonDay {
  start: number; // the stop's start and end, minutes from midnight on its date
  end: number;
  date?: string; // YYYY-MM-DD; without it nothing is said about the date
  trip?: TripDays; // the rest of the trip, for "It cannot be visited on Sunday"
  seated?: readonly Meal[]; // the day's meal stops; without it no "Lunch is part of this outing"
  highestRated?: boolean; // the only stop of the day with the highest rating (isHighestRated)
}

/**
 * A reason built only from data, at most REASON_MAX_CHARS long and never empty. Sentences are
 * added in priority order while they fit; a sentence too long for the limit (a very long tag, say)
 * is skipped rather than cut mid-word.
 *
 * "You asked to include this." when must-include; "Matches your interest in food and wine.";
 * then, with `day`, what the date means for the stop ("It cannot be visited on Sunday, the
 * trip's last day.", "It opens later on Sunday than on other days.", "Starts as it opens.");
 * "Listed as iconic and a local favorite."; "The day's highest-rated stop."; "Rated 4.8 out of
 * 5."; "The listing calls it an evening place."; and "Lunch is part of this outing." A lunch or
 * dinner opens with "Close to your previous stop." when that stop is a walk away. When none
 * apply: "Suggested stop.", "Lunch stop." or "Dinner stop.", which the page does not show.
 */
export function ruleReason(
  place: ReasonPlace,
  request: Pick<TripRequest, "interests" | "mustInclude">,
  role: StopRole,
  prevPlace?: LatLng | null,
  day?: ReasonDay,
): string {
  const sentences: string[] = [];
  // Decision: "close to your previous stop" only for a meal, and only when the leg is a walk.
  // Saying it of a taxi ride would be a claim the data does not support.
  if (role !== "visit" && prevPlace && isWalk(prevPlace, place)) {
    sentences.push("Close to your previous stop.");
  }
  if (request.mustInclude.includes(place.id)) sentences.push("You asked to include this.");
  const named = matchedInterests(place, request.interests).slice(0, MAX_NAMED_INTERESTS);
  if (named.length > 0) {
    sentences.push(`Matches your interest in ${joinWords(named.map(interestWords), "and")}.`);
  }
  if (day && isDated(day)) sentences.push(...dateSentences(place, role, day));
  const listed = listedSentence(place, named);
  if (listed) sentences.push(listed);
  if (day?.highestRated) sentences.push("The day's highest-rated stop.");
  const rating = ratingSentence(place);
  if (rating) sentences.push(rating);
  const slot = day && role === "visit" ? timeOfDaySentence(place, day) : null;
  if (slot) sentences.push(slot);
  // Decision: the outing's meal comes last. The board labels the row "Lunch during this visit"
  // and drops the sentence (lib/reasonText.ts), so placed earlier it would take room from
  // sentences the board then shows. The swap sheet, which has no such label, may lose it when
  // the line is long.
  const covered = day?.seated ? mealsCovered(place, role, day, day.seated) : [];
  if (covered.length > 0) sentences.push(coveredSentence(covered));
  return fitSentences(sentences, FALLBACK[role]);
}

/** The meals a visit is under way through (coversMeal) that the day has no stop for. */
function mealsCovered(
  place: Pick<Place, "mealCapable" | "durationMin">,
  role: StopRole,
  times: { start: number; end: number },
  seated: readonly Meal[],
): Meal[] {
  if (role !== "visit") return [];
  return (["lunch", "dinner"] as const).filter(
    (meal) => !seated.includes(meal) && coversMeal(place, times.start, times.end, meal),
  );
}

/** "Lunch is part of this outing." or "Lunch and dinner are part of this outing." */
function coveredSentence(meals: readonly Meal[]): string {
  const verb = meals.length > 1 ? "are" : "is";
  return `${capitalize(joinWords(meals, "and"))} ${verb} part of this outing.`;
}

/**
 * True for the one stop whose place has the highest rating of the day, strictly above every
 * other stop's. A tie, a missing rating, or a day of one stop gives false for every stop.
 */
// Decision: strictly highest, so the sentence is said at most once a day and never of a tie. A
// stop without a rating ranks below every rated one, as for the day's photos (web thumbnailRows).
export function isHighestRated(
  ratings: readonly (number | null | undefined)[],
  index: number,
): boolean {
  const own = ratings[index];
  if (ratings.length < 2 || typeof own !== "number" || !Number.isFinite(own)) return false;
  return ratings.every(
    (other, at) => at === index || typeof other !== "number" || !(other >= own), // NaN is lower
  );
}

// ---------- The stop's date ----------

type DatedDay = ReasonDay & { date: string };

function isDated(day: ReasonDay): day is DatedDay {
  return day.date !== undefined;
}

/** What the stop's date means for it, most specific first. */
// Decision: nothing about the date when the planner's hours are not the whole listing: a note it
// recorded but did not apply (note_not_applied, note_unread), or read over the listed hours
// (hours_conflict). Such a note can open the place when the planner has it shut, or shut it when
// the planner has it open. The Vatican Museums are "Closed Sundays except last Sunday of the
// month", which the planner does not read, so "It cannot be visited on Sunday" was false whenever
// that Sunday was the month's last; the Brera market's "Third weekend of each month only" is read
// as days 15 to 21, where the weekend may be the 21st and 22nd. The scheduler keeps the safe
// reading; the line would state it as the listing's fact. Nor on a date most museums and ticketed
// sites close (closedForHoliday): whether it opens at all that day is the open question, so the
// line says nothing of the date ("Starts as it opens." on 25 December could not be shown true).
function dateSentences(place: ReasonPlace, role: StopRole, day: DatedDay): string[] {
  if (place.issues.some((issue) => UNSETTLED_HOURS.includes(issue.kind))) return [];
  const today = statusOn(place, day.date);
  // A stop on a day its place is shut is an error the validator shows; nothing here explains it.
  if (today === null || today.state === "closed" || closedForHoliday(place, day.date)) return [];
  const out: string[] = [];
  const trip = tripSentence(place, day);
  if (trip) out.push(trip);
  if (place.hoursConfidence === "listed" && today.state === "open") {
    const later = laterOpeningSentence(place, day, today.ranges[0]?.open);
    if (later) out.push(later);
    const opening = openingSentence(place, role, day, today);
    if (opening) out.push(opening);
  }
  return out;
}

/**
 * "It cannot be visited on Sunday, the trip's last day." for the trip's other days at this
 * stop's base that the place is shut, or "The only day of this trip it can be visited." when
 * that is every other day of the trip. Null when the place can be visited on all of them.
 */
// Decision: only the days at the same base. A Rome museum shut on the trip's Florence day says
// nothing the traveler can use there. "Shut" is the planner's closed state (openStatusOn: weekly
// hours, seasons, date rules), the same answer that makes the validator reject a visit that day.
function tripSentence(place: ReasonPlace, day: DatedDay): string | null {
  const trip = day.trip;
  const here = trip?.days[trip.index];
  if (!trip || !here) return null;
  const others = trip.days
    .map((other, index) => ({ ...other, index }))
    .filter((other) => other.index !== trip.index);
  const shut = others.filter(
    (other) => other.anchorId === here.anchorId && statusOn(place, other.date)?.state === "closed",
  );
  if (shut.length === 0) return null;
  if (shut.length === others.length) return "The only day of this trip it can be visited.";
  const names = shut.map((other) => weekdayName(other.date));
  const [only] = shut;
  if (shut.length === 1 && only) {
    const ordinal = only.index === trip.days.length - 1 ? "last" : DAY_ORDINALS[only.index];
    if (ordinal) return `It cannot be visited on ${names[0]}, the trip's ${ordinal} day.`;
  }
  return `It cannot be visited on ${joinWords(names, "or")} of this trip.`;
}

/**
 * "It opens later on Sunday than on other days." when the place's first opening on the stop's
 * date is later than on every other day of that week it opens. Listed hours only.
 */
// Decision: the other six days are real dates (the date plus one to six days), asked of
// openStatusOn like the stop's own, so seasons and date rules count and no hours are read by
// hand. Only "opens later": the words for a day that ends earlier ("closes early") are what the
// sanitizer rejects, and the opened stop shows the date's hours in full.
function laterOpeningSentence(
  place: ReasonPlace,
  day: DatedDay,
  firstOpen: number | undefined,
): string | null {
  if (firstOpen === undefined) return null;
  const otherOpens: number[] = [];
  for (let offset = 1; offset < 7; offset++) {
    const status = statusOn(place, addDays(day.date, offset));
    const open = status?.state === "open" ? status.ranges[0]?.open : undefined;
    if (open !== undefined) otherOpens.push(open);
  }
  if (otherOpens.length === 0 || otherOpens.some((open) => open >= firstOpen)) return null;
  return `It opens later on ${weekdayName(day.date)} than on other days.`;
}

/**
 * "Starts as it opens." when the stop starts at the opening of the range it is timed in, "Starts
 * as it reopens." for a later range (a restaurant's evening), and for a visit "Starts soon after
 * it opens." within SOON_AFTER_OPENING_MIN. Null when the visit does not fit one range.
 */
function openingSentence(
  place: ReasonPlace,
  role: StopRole,
  day: DatedDay,
  today: Extract<OpenStatus, { state: "open" }>,
): string | null {
  // The validator's own answer; the date was read above, so it cannot throw here.
  if (isOpenDuring(place, day.date, day.start, day.end) !== "yes") return null;
  const index = today.ranges.findIndex(
    (range) => range.open <= day.start && day.end <= range.close,
  );
  const range = today.ranges[index];
  if (!range) return null;
  const verb = index === 0 ? "opens" : "reopens";
  if (day.start === range.open) return `Starts as it ${verb}.`;
  if (role === "visit" && day.start - range.open <= SOON_AFTER_OPENING_MIN) {
    return `Starts soon after it ${verb}.`;
  }
  return null;
}

/** openStatusOn, or null on a date it cannot read (a bad date makes no claim at all). */
function statusOn(place: ReasonPlace, date: string): OpenStatus | null {
  try {
    return openStatusOn(place, date);
  } catch {
    return null;
  }
}

function weekdayName(date: string): string {
  return WEEKDAY_LONG[weekdayOf(date)];
}

// ---------- The place's listing ----------

/** The traveler's interests the place is tagged with, in the order asked, without repeats. */
function matchedInterests(place: ReasonPlace, interests: readonly string[]): string[] {
  return [...new Set(interests)].filter((interest) => place.tags.includes(interest));
}

/** "local-favorite" reads "local favorite". */
function interestWords(tag: string): string {
  return tag.replace(/-/g, " ");
}

/**
 * "Listed as iconic and a local favorite." for the rewarded tags the place carries, or null. A
 * tag already named as a matched interest is not said twice.
 */
function listedSentence(place: ReasonPlace, named: readonly string[]): string | null {
  const words = LISTED_TAGS.filter(
    ({ tag }) => place.tags.includes(tag) && !named.includes(tag),
  ).map((listed) => listed.words);
  return words.length === 0 ? null : `Listed as ${joinWords(words, "and")}.`;
}

/**
 * "The listing calls it an evening place." when the place carries a time-of-day tag and at least
 * half the visit is in that part of the day (TIME_OF_DAY_TAGS), or null.
 */
function timeOfDaySentence(
  place: ReasonPlace,
  times: { start: number; end: number },
): string | null {
  const midpoint = (times.start + times.end) / 2;
  const slot = TIME_OF_DAY_TAGS.find(
    ({ tag, holds }) => place.tags.includes(tag) && holds(midpoint),
  );
  return slot ? `The listing calls it ${slot.words}.` : null;
}

/** "Rated 4.8 out of 5." with at most one decimal, or null without a rating. */
function ratingSentence(place: ReasonPlace): string | null {
  if (place.rating === null || !Number.isFinite(place.rating)) return null;
  return `Rated ${Number(place.rating.toFixed(1))} out of 5.`;
}

function isWalk(from: LatLng, to: LatLng): boolean {
  try {
    return travelMode(from, to) === "walk";
  } catch {
    return false; // non-finite coordinates: make no closeness claim
  }
}

/** Joins sentences in order while the total fits REASON_MAX_CHARS; `fallback` when none fit. */
function fitSentences(sentences: string[], fallback: string): string {
  let text = "";
  for (const sentence of sentences) {
    // Control and format characters from the data (newlines, bidi overrides) become spaces.
    const clean = sentence.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
    const next = text === "" ? clean : `${text} ${clean}`;
    if (next.length <= REASON_MAX_CHARS) text = next;
  }
  return text === "" ? fallback : text;
}

/** "a, b and c" or "a, b or c". */
function joinWords(words: readonly string[], last: "and" | "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
