import { LATEST_MINUTE, MEALS } from "./config";
import { coversMeal } from "./constraints";
import type { PlannerContext } from "./context";
import { foldText } from "./normalize/issue";
import { parseIsoDate } from "./time";
import type { DayPlan, Meal, Place, Stop } from "./types";

// What an AI reason claims about when its stop happens, checked against the stop as timed. The
// model writes its reasons before code has the last word on the plan: the API's tidy step drops
// and moves stops, the scheduler sets every time and meal role, and an edit on the page times the
// day again, so "a memorable dinner" can land on the lunch stop and "to start the day" on the
// fifth. A reason that names a meal, a part of the day, the sun, or a place in the day or the trip
// is kept only when that holds for this stop on this date; otherwise the stop gets its rule
// reason, from the API's applyAiReasons for a new plan and from attachReasons (trip.ts) after an
// edit.
// Decision: in the planner, not in the API's textGuards.ts. The sanitizer reads text alone and
// also runs over rule reasons (ruleReasons.test.ts), whose "the trip's last day" is about another
// day. These checks need the timed stop, its day, its date and its place, and they must run
// wherever a stop is timed again: the page's edits re-time a day in the browser, where the API
// cannot see it, so both read this one copy.
// Decision: every check errs toward dropping, like the sanitizer. A false drop costs a factual
// rule reason; a missed one shows the traveler something untrue about this stop.

export type ClaimKind = "meal" | "time_of_day" | "position";

/** A claim the stop does not bear out: its kind and the words that made it. */
export interface Contradiction {
  kind: ClaimKind;
  claim: string; // normalized words, e.g. "dinner", "morning", "to start the day"
}

/** A timed day as the check reads it. */
export type ClaimDay = Pick<DayPlan, "date" | "anchorId"> & { stops: readonly Stop[] };

/**
 * One stop in its timed trip: the days and which stop of which day. Only that day's stops are
 * read; the other days give their date and base (the trip's first and last day, and each base's).
 */
export interface StopInTrip {
  days: readonly ClaimDay[];
  day: number;
  index: number;
}

const at = (hour: number, minute = 0): number => hour * 60 + minute;

/** A stretch of the stop's date, [from, to) in minutes from midnight. */
interface Window {
  from: number;
  to: number;
}

/**
 * The parts of the day a reason may name, and the meals that are times of day rather than stops.
 * A stop is in a part when at least half of it, or at least PART_MIN_OVERLAP minutes of it, falls
 * inside the window.
 */
// Decision: noon and 18:00 are the planner's own lines (outings and treats turn on noon, and its
// evening starts at 18:00 with the evening-only places). Half, so a 30-minute stop from 17:45 is
// both afternoon and evening, while a museum from 10:50 to 12:20 is not "an afternoon walk" and a
// lunch from 12:00 is not "a morning start". An hour, so a day trip from 10:50 to 18:50 is a
// morning and an afternoon outing. Breakfast to 11:00 and aperitivo from 17:00 to 21:00 match the
// planner's aperitivo hour (APERITIVO_EARLIEST_START, the data's 17:30 to 21:00 name window).
// The evening and the early evening start sooner when the sun sets before 18:00 (inEvening).
export const PARTS_OF_DAY = {
  earlyMorning: { from: at(5), to: at(10) },
  morning: { from: at(5), to: at(12) },
  lateMorning: { from: at(10), to: at(12) },
  midday: { from: at(11), to: at(15) },
  earlyAfternoon: { from: at(12), to: at(15) },
  afternoon: { from: at(12), to: at(18) },
  lateAfternoon: { from: at(15), to: at(18) },
  earlyEvening: { from: at(18), to: at(20) },
  evening: { from: at(18), to: LATEST_MINUTE },
  lateEvening: { from: at(21), to: LATEST_MINUTE },
  breakfast: { from: at(6), to: at(11) },
  brunch: { from: at(10), to: at(14) },
  aperitivo: { from: at(17), to: at(21) },
} as const satisfies Record<string, Window>;

type Part = keyof typeof PARTS_OF_DAY;

/** Minutes of a part the stop must fill when it is shorter than twice that. */
export const PART_MIN_OVERLAP = 60;

/**
 * Night starts at NIGHT_FROM, late night at LATE_NIGHT_FROM, and neither before dark:
 * DUSK_AFTER_SUNSET_MIN after sunset at the place on the stop's date.
 */
// Decision: the sun decides sunset, dusk, golden hour, sunrise, daylight, "after dark" and night,
// computed for the place on the stop's date (sunTimes), never a fixed clock time. Sunset in Italy
// moves from about 16:40 in December to 21:15 in June, so a fixed window either keeps "sunset
// views" at 18:00 in June or drops it in October. The planner's SUNSET_BY_MONTH is a planning
// estimate for parks, rounded and up to about 40 minutes off within a month; a claim shown to the
// traveler needs the day's own sunset. Night needs both the clock (20:00, the data's own window
// for "by Night" places) and the dark, so "shines at night" at 20:00 on 19 May in Rome, 25
// minutes before sunset, is dropped. Half an hour after sunset is civil dusk in Italy.
export const NIGHT_FROM = at(20);
export const LATE_NIGHT_FROM = at(22);
export const DUSK_AFTER_SUNSET_MIN = 30;

/** Sunset and sunrise hold when the stop is under way within this many minutes of them. */
export const SUN_MOMENT_MIN = 20;

/** Golden hour is the hour before sunset; dusk and twilight are the DUSK_SPAN_MIN after it. */
export const GOLDEN_HOUR_MIN = 60;
export const DUSK_SPAN_MIN = 40;

/**
 * "Before dinner", "after lunch" and "on the way to dinner" hold when the meal is the next (or
 * previous) stop of the day and starts (or ends) at most this many minutes away.
 */
// Decision: next to it, and near it. In a timetable "a calm stop before dinner" reads as the thing
// before dinner: the Trevi Fountain from 13:30 is dropped though the day's next stop is dinner at
// 19:30. Two hours covers a walk, a wait for the restaurant, and a slow afternoon stop.
export const NEXT_TO_MEAL_MIN = 120;

// ---------- The stop as the checks see it ----------

interface Sun {
  rise: number; // minutes from local midnight
  set: number;
}

interface View {
  stop: Stop;
  place: Place | undefined;
  stops: readonly Stop[];
  index: number;
  day: number;
  days: readonly ClaimDay[];
  ctx: PlannerContext;
  sun: () => Sun | null;
}

type Test = (view: View) => boolean;

const overlapOf = (stop: Pick<Stop, "start" | "end">, window: Window): number =>
  Math.min(stop.end, window.to) - Math.max(stop.start, window.from);

/** True when at least half the stop, or PART_MIN_OVERLAP minutes of it, is inside the window. */
function fills(stop: Pick<Stop, "start" | "end">, window: Window): boolean {
  const overlap = overlapOf(stop, window);
  return overlap > 0 && (overlap * 2 >= stop.end - stop.start || overlap >= PART_MIN_OVERLAP);
}

/** True when the stop is under way at some moment of the window. */
const touches = (stop: Pick<Stop, "start" | "end">, window: Window): boolean =>
  overlapOf(stop, window) > 0;

const inPart =
  (part: Part): Test =>
  (view) =>
    fills(view.stop, PARTS_OF_DAY[part]);

/**
 * The evening or the early evening: the part's window, from sunset at the place on the stop's
 * date when the sun sets before the part's 18:00.
 */
// Decision: the evening starts at 18:00 or at sunset, whichever is earlier. On 20 December the
// sun sets in Florence at about 16:40, so "an evening stroll" from 17:15 is a walk after dark
// under the lights, and it is kept. The morning and the afternoon keep their clock lines: the
// afternoon still runs to 18:00, so that stroll is both. On a date the sun cannot be read for,
// the evening starts at 18:00.
const inEvening =
  (part: "evening" | "earlyEvening"): Test =>
  (view) => {
    const window = PARTS_OF_DAY[part];
    const from = Math.min(window.from, view.sun()?.set ?? window.from);
    return fills(view.stop, { from, to: window.to });
  };

/** A window measured from the day's sunrise or sunset; false when the sun cannot be read. */
const bySun =
  (window: (sun: Sun) => Window, test: typeof fills = fills): Test =>
  (view) => {
    const sun = view.sun();
    return sun !== null && test(view.stop, window(sun));
  };

const darkFrom = (sun: Sun, clock: number) => Math.max(clock, sun.set + DUSK_AFTER_SUNSET_MIN);

/** The stop is that meal: its role, or an outing under way through it (coversMeal). */
function isMeal(stop: Stop, place: Place | undefined, meal: Meal): boolean {
  if (stop.role === meal) return true;
  return (
    stop.role === "visit" && place !== undefined && coversMeal(place, stop.start, stop.end, meal)
  );
}

/**
 * A meal word holds for the stop: it has that meal's role, or it is a visit somewhere to eat
 * (eatsThere) under way in the meal's window (MEALS) on a day whose other stops do not include
 * that meal (isMeal).
 */
// Decision: a meal word on a visit holds when the visit overlaps that meal's window (MEALS, the
// planner's own lunch and dinner windows), no other stop of the day is that meal, by its role or
// as an outing under way through it, and the place is somewhere to eat. A day without a dinner
// stop eats somewhere: Pigneto from 18:20 to 20:20 is "a local food scene for dinner", and gelato
// at Giolitti at 13:00 is "a light lunch treat" (live answers of 2026-09-25). A day that has the
// meal elsewhere keeps the word off the visit: Roscioli visited at 13:25, just after a lunch at
// 12:00, is not "a delicious lunch". Nor does a day without the meal make a sight a meal: "a
// romantic dinner spot" on the Trevi Fountain from 18:50, or "lunch among the ruins" at the
// Colosseum until 12:10, names a meal the traveler cannot have there.
const servesAsMeal =
  (meal: Meal): Test =>
  (view) => {
    if (view.stop.role !== "visit") return view.stop.role === meal;
    const window = { from: MEALS[meal].earliestStart, to: MEALS[meal].latestStart };
    const elsewhere = view.stops.some(
      (other, position) => position !== view.index && isMeal(other, placeOf(view, other), meal),
    );
    return touches(view.stop, window) && !elsewhere && eatsThere(view, meal);
  };

/**
 * Place types that are somewhere to eat whether or not the data marks them a meal place. Not
 * "market": the book and antique markets sell no food, and every food market is tagged food.
 */
const EATING_TYPES: readonly Place["type"][] = ["restaurant", "cafe"];

/**
 * The visit's place is somewhere to eat: a meal place, a cafe or restaurant, a place the listing
 * tags food, or an outing under way through the meal (coversMeal).
 */
function eatsThere(view: View, meal: Meal): boolean {
  const place = view.place;
  if (!place) return false;
  return (
    place.mealCapable ||
    EATING_TYPES.includes(place.type) ||
    place.tags.includes("food") ||
    coversMeal(place, view.stop.start, view.stop.end, meal)
  );
}

function placeOf(view: View, stop: Stop | undefined): Place | undefined {
  return stop === undefined ? undefined : view.ctx.placesById.get(stop.placeId);
}

const isFirst: Test = (view) => view.index === 0;
// Decision: "to start exploring Florence" after the arrival day's lunch is true: exploring is
// visits, so a meal before it does not count.
const isFirstVisit: Test = (view) =>
  view.stop.role === "visit" &&
  view.stops.slice(0, view.index).every((stop) => stop.role !== "visit");
const isLast: Test = (view) => view.index === view.stops.length - 1;
const onFirstDay: Test = (view) => view.day === 0;
const onLastDay: Test = (view) => view.day === view.days.length - 1;

/** Days of the trip at this stop's base, by index. */
function baseDays(view: View): number[] {
  const anchorId = view.days[view.day]?.anchorId;
  return view.days.flatMap((day, index) => (day.anchorId === anchorId ? [index] : []));
}

const onFirstDayAtBase: Test = (view) => baseDays(view)[0] === view.day;
const onLastDayAtBase: Test = (view) => baseDays(view).at(-1) === view.day;

/** The next (or previous) stop is the meal, at most NEXT_TO_MEAL_MIN away. */
function nextToMeal(meal: Meal, side: "before" | "after"): Test {
  return (view) => {
    const other = view.stops[side === "before" ? view.index + 1 : view.index - 1];
    if (!other || !isMeal(other, placeOf(view, other), meal)) return false;
    const gap = side === "before" ? other.start - view.stop.end : view.stop.start - other.end;
    return gap <= NEXT_TO_MEAL_MIN;
  };
}

/** Some earlier (or later) stop of the day passes the test. */
function someStop(side: "before" | "after", test: (stop: Stop, place?: Place) => boolean): Test {
  return (view) => {
    const others =
      side === "before" ? view.stops.slice(0, view.index) : view.stops.slice(view.index + 1);
    return others.some((stop) => test(stop, placeOf(view, stop)));
  };
}

const isMuseum = (_: Stop, place?: Place) => place?.type === "museum";

/** The stop is in the part of the day, and no earlier visit of the day is. */
function firstIn(test: Test): Test {
  return (view) =>
    test(view) &&
    view.stops
      .slice(0, view.index)
      .every(
        (stop) => stop.role !== "visit" || !test({ ...view, stop, place: placeOf(view, stop) }),
      );
}

const both =
  (...tests: Test[]): Test =>
  (view) =>
    tests.every((test) => test(view));

// ---------- Words ----------

const LUNCH = "lunch|lunches|lunchtime|luncheon|pranzo";
const DINNER = "dinner|dinners|dinnertime|supper|suppers|cena";
// Decision: no "tour". "Start the tour at the east gate" is about the stop's own guided tour.
const TRIP = "trip|holiday|vacation|stay|journey|getaway";
const DET = "(?:the|your|a|an|this)";
const START =
  "start|starts|starting|begin|begins|beginning|kick off|kicks off|kicking off|kickstart|kick start";
const END =
  "end|ends|ending|finish|finishes|finishing|wrap up|wraps up|wrapping up|round off|rounds off|rounding off|round out|rounds out|rounding out|wind down|winds down|winding down|cap off|caps off|capping off|cap|caps|capping|top off|tops off|topping off|conclude|concludes|concluding|close|closes|closing";
/** Nouns for a start or an end: "a kick-off to the day", "the wrap-up of the trip". */
const START_NOUN = "start|beginning|kick off|kickoff";
const END_NOUN = "end|close|finish|ending|finale|conclusion|wrap up|wrapup|wind down|winddown";
const SOME_WORDS = "(?:[a-z]+ ){0,2}";
const EXPLORING = `exploring|sightseeing|${DET} (?:sightseeing|exploration)`;
/** The parts of a day and the meals that "first" and "last" can pick out. */
const OCCASION = "day|night|evening|morning|afternoon|dinner|lunch|meal|supper";
// Decision: "of the trip" and "in Italy" scope a first or last to the trip, not the base, so
// "the last night of the trip" is not kept on the last night in Rome of a trip that goes on to
// Florence. "Of your stay in Rome" is the base.
const OF_THE_TRIP = `(?:of|on) ${DET} (?:[a-z]+ )?(?:${TRIP})(?! in)|in italy`;

const words = (source: string) => new RegExp(`\\b(?:${source})\\b`, "g");

interface Rule {
  kind: ClaimKind;
  pattern: RegExp;
  holds: Test;
}

/**
 * Phrases that place the stop next to a meal or a museum. Checked before the meal words and then
 * blanked out, so "after lunch" is a claim about the previous stop, not that this stop is lunch.
 */
const BESIDE_RULES: readonly Rule[] = [
  {
    kind: "position",
    pattern: words(`between ${DET}? ?(?:${LUNCH}) and ${DET}? ?(?:${DINNER})`),
    holds: both(
      someStop("before", (stop, place) => isMeal(stop, place, "lunch")),
      someStop("after", (stop, place) => isMeal(stop, place, "dinner")),
    ),
  },
  ...(["lunch", "dinner"] as const).flatMap((meal): Rule[] => {
    const nouns = meal === "lunch" ? LUNCH : DINNER;
    return [
      {
        kind: "position",
        pattern: words(
          `(?:before|ahead of|pre|prior to|until|till|on (?:the|your) way to|en route to|to work up an appetite for|prima di|prima del|prima della) ${DET}? ?${SOME_WORDS}(?:${nouns})`,
        ),
        holds: nextToMeal(meal, "before"),
      },
      {
        kind: "position",
        pattern: words(
          `(?:after|post|following|to walk off|to digest|dopo) ${DET}? ?${SOME_WORDS}(?:${nouns})`,
        ),
        holds: nextToMeal(meal, "after"),
      },
    ];
  }),
  {
    kind: "position",
    pattern: words("nightcap|nightcaps|digestif|digestivo"),
    holds: both(
      isLast,
      someStop("before", (stop, place) => isMeal(stop, place, "dinner")),
    ),
  },
  {
    kind: "position",
    pattern: words(`before ${DET}? ?${SOME_WORDS}(?:museum|museums|gallery|galleries)`),
    holds: someStop("after", isMuseum),
  },
  {
    kind: "position",
    pattern: words(
      `(?:after|following) ${DET}? ?${SOME_WORDS}(?:museum|museums|gallery|galleries)`,
    ),
    holds: someStop("before", isMuseum),
  },
  {
    kind: "position",
    pattern: words(`after ${DET} (?:(?:long|full|busy|big|whole|great) )?day`),
    holds: (view) => view.index > 0 && (isLast(view) || view.stop.role === "dinner"),
  },
  // "Lunch after a morning of sightseeing" says the morning came before, not that this is morning.
  ...(["morning", "afternoon"] as const).map(
    (part): Rule => ({
      kind: "position",
      pattern: words(`after ${DET} (?:[a-z]+ )?${part}`),
      holds: someStop("before", (stop) => fills(stop, PARTS_OF_DAY[part])),
    }),
  ),
  // "Glows after sunset" and "best before sunset" set the stop against the sun, not at it.
  {
    kind: "time_of_day",
    pattern: words("(?:after|past|following) (?:the )?(?:sunset|sundown)"),
    holds: bySun((sun) => ({ from: sun.set, to: LATEST_MINUTE })),
  },
  {
    kind: "time_of_day",
    pattern: words("(?:after|past|following) (?:the )?(?:dusk|nightfall)"),
    holds: bySun((sun) => ({ from: sun.set + DUSK_SPAN_MIN, to: LATEST_MINUTE })),
  },
  {
    kind: "time_of_day",
    pattern: words("before (?:the )?(?:sunset|sundown|dusk|nightfall|dark)"),
    holds: bySun((sun) => ({ from: sun.rise, to: sun.set })),
  },
];

/** Where the stop falls in its day, at its base, and in the trip. */
const POSITION_RULES: readonly Rule[] = [
  // The trip.
  {
    kind: "position",
    pattern: words(
      `(?:${START}) ${DET} (?:[a-z]+ )?(?:${TRIP})|(?:${START_NOUN}) (?:to|of) ${DET} (?:[a-z]+ )?(?:${TRIP})`,
    ),
    holds: both(onFirstDay, isFirst),
  },
  {
    kind: "position",
    pattern: words(
      `(?:${END}) ${DET} (?:[a-z]+ )?(?:${TRIP})|(?:${END_NOUN}) (?:to|of) ${DET} (?:[a-z]+ )?(?:${TRIP})|(?:last|final) (?:stop|visit|sight) (?:of|on|in) ${DET} (?:[a-z]+ )?(?:${TRIP})`,
    ),
    holds: both(onLastDay, isLast),
  },
  {
    kind: "position",
    pattern: words(
      `(?:first|opening) (?:${OCCASION})(?: (?:${OF_THE_TRIP})|(?! (?:in|of|at)))|welcome (?:dinner|lunch|drinks?|aperitivo|meal|toast)`,
    ),
    holds: onFirstDay,
  },
  {
    kind: "position",
    pattern: words(
      `(?:last|final) (?:${OCCASION})(?: (?:${OF_THE_TRIP})|(?! (?:in|of|at)))|farewell`,
    ),
    holds: onLastDay,
  },
  // The base: "the first evening in Rome", "a first taste of Florence".
  {
    kind: "position",
    pattern: words(
      "(?:first|opening) (?:day|night|evening|morning|afternoon|dinner|lunch|meal|supper) (?:in|of|at)",
    ),
    holds: onFirstDayAtBase,
  },
  {
    kind: "position",
    pattern: words(
      "(?:last|final) (?:day|night|evening|morning|afternoon|dinner|lunch|meal|supper) (?:in|of|at)",
    ),
    holds: onLastDayAtBase,
  },
  {
    kind: "position",
    pattern: words(
      "first (?:taste|tastes|glimpse|glimpses|look|impression|impressions|view|introduction)",
    ),
    holds: both(onFirstDayAtBase, isFirst),
  },
  {
    kind: "position",
    pattern: words(
      "(?:last|final|parting) (?:taste|tastes|glimpse|glimpses|look|impression|impressions|view)",
    ),
    holds: both(onLastDayAtBase, isLast),
  },
  // The day.
  {
    kind: "position",
    pattern: words(
      [
        `(?:${START}) ${DET} (?:[a-z]+ )?(?:day|morning)`,
        `(?:${START_NOUN}) (?:to|of) ${DET} (?:[a-z]+ )?(?:day|morning)`,
        "(?:day|morning)(?: s)? start",
        `(?:a|an)(?: [a-z]+){0,3} start(?! (?:${EXPLORING}))`,
        "early start",
        "starting point",
        `(?:start|starting|begin|beginning) ${DET} (?:visit|walk)`,
        "first (?:stop|sight|thing|port of call)|first visit(?! to)",
        `to (?:start|begin|kick off)(?! (?:${EXPLORING})| ${DET} (?:[a-z]+ )?(?:afternoon|evening|night|${TRIP}))`,
      ].join("|"),
    ),
    holds: isFirst,
  },
  {
    kind: "position",
    pattern: words(`(?:start|starting|begin|beginning) (?:${EXPLORING})`),
    holds: isFirstVisit,
  },
  {
    kind: "position",
    pattern: words(
      [
        `(?:${END}) ${DET} (?:[a-z]+ )?(?:day|evening|night)`,
        `(?:${END_NOUN}) (?:to|of) ${DET} (?:[a-z]+ )?(?:day|evening|night)`,
        "(?:day|evening|night)(?: s)? (?:end|winds? down|winding down)",
        "(?:day|evening|night) s (?:[a-z]+ )?finale",
        "(?<!(?:to|near|from|after|by|beside|past) the )(?:last|final) (?:stop|visit|sight|stroll|walk|treat|toast|drink)",
        "(?:a|an|the)(?: [a-z]+){0,3} (?<!never )(?:ending|finale)",
        "one (?:last|final)",
      ].join("|"),
    ),
    holds: isLast,
  },
  {
    kind: "position",
    pattern: words(`(?:${START}) ${DET} (?:[a-z]+ )?afternoon|afternoon start`),
    holds: firstIn(inPart("afternoon")),
  },
  {
    kind: "position",
    pattern: words(`(?:${START}) ${DET} (?:[a-z]+ )?evening|evening start`),
    holds: firstIn(inEvening("evening")),
  },
  {
    kind: "position",
    pattern: words(`(?:${START}) ${DET} (?:[a-z]+ )?night|night start`),
    holds: firstIn(bySun((sun) => ({ from: darkFrom(sun, NIGHT_FROM), to: LATEST_MINUTE }))),
  },
];

/** Meals, parts of the day, and the sun. Every match must hold. */
// Decision: a word that describes the place rather than the stop is still read as a claim about
// the stop: "known for its evening atmosphere" on Trastevere from 13:35, or "a morning market" for
// a lunch at 12:00, is dropped. The line is read beside the stop's time, where it reads as what
// the traveler will find then, and the words alone do not tell a description from a promise. As
// everywhere here, the check errs toward dropping (the owner's call, 2026-09-25).
const WORD_RULES: readonly Rule[] = [
  { kind: "meal", pattern: words(LUNCH), holds: servesAsMeal("lunch") },
  { kind: "meal", pattern: words(DINNER), holds: servesAsMeal("dinner") },
  {
    kind: "meal",
    pattern: words("meal|meals"),
    holds: (view) =>
      view.stop.role !== "visit" || servesAsMeal("lunch")(view) || servesAsMeal("dinner")(view),
  },
  {
    kind: "meal",
    pattern: words("breakfast|breakfasts|colazione"),
    holds: both((view) => view.stop.role === "visit", inPart("breakfast")),
  },
  {
    kind: "meal",
    pattern: words("brunch"),
    holds: both((view) => view.stop.role !== "dinner", inPart("brunch")),
  },
  {
    kind: "meal",
    pattern: words("aperitivo|aperitivi|aperitif|aperitifs|apero|happy hour|spritz hour"),
    holds: both((view) => view.stop.role !== "lunch", inPart("aperitivo")),
  },
  {
    kind: "time_of_day",
    pattern: words(
      "early mornings?|early start|early risers?|early birds?|(?:arrive|go|come|get there|be there|visit|head there) early",
    ),
    holds: inPart("earlyMorning"),
  },
  { kind: "time_of_day", pattern: words("late mornings?"), holds: inPart("lateMorning") },
  {
    kind: "time_of_day",
    pattern: words("mornings?|mattina|mattino|mattinata"),
    holds: inPart("morning"),
  },
  { kind: "time_of_day", pattern: words("midday|mid day"), holds: inPart("midday") },
  { kind: "time_of_day", pattern: words("early afternoons?"), holds: inPart("earlyAfternoon") },
  { kind: "time_of_day", pattern: words("late afternoons?"), holds: inPart("lateAfternoon") },
  { kind: "time_of_day", pattern: words("afternoons?|pomeriggio"), holds: inPart("afternoon") },
  { kind: "time_of_day", pattern: words("early evenings?"), holds: inEvening("earlyEvening") },
  { kind: "time_of_day", pattern: words("late evenings?"), holds: inPart("lateEvening") },
  {
    kind: "time_of_day",
    pattern: words("evenings?|sera|serata|serale|serali"),
    holds: inEvening("evening"),
  },
  {
    kind: "time_of_day",
    pattern: words("late nights?"),
    holds: bySun((sun) => ({ from: darkFrom(sun, LATE_NIGHT_FROM), to: LATEST_MINUTE })),
  },
  // Decision: "your last night in Florence", "a night out", "date night" and "tonight" name the
  // evening, not the dark: a 19:30 dinner in June is the traveler's last night though the sun is
  // still up. The dark is for what the night itself shows ("shines at night").
  {
    kind: "time_of_day",
    pattern: words("(?:first|last|final|opening|date) nights?|nights? out|tonight"),
    holds: inEvening("evening"),
  },
  {
    kind: "time_of_day",
    pattern: words(
      "(?<!(?:first|last|final|opening|date) )nights?(?! out)|nighttime|night time|nightlife|night life|notte|notturna|notturno",
    ),
    holds: bySun((sun) => ({ from: darkFrom(sun, NIGHT_FROM), to: LATEST_MINUTE })),
  },
  {
    kind: "time_of_day",
    pattern: words(
      "after dark|in the dark|lit up|floodlit|under the stars|starlit|starry|moonlit|moonlight",
    ),
    holds: bySun((sun) => ({ from: sun.set + DUSK_AFTER_SUNSET_MIN, to: LATEST_MINUTE })),
  },
  {
    kind: "time_of_day",
    pattern: words("daytime|day time|daylight|by day"),
    holds: bySun((sun) => ({ from: sun.rise, to: sun.set })),
  },
  {
    kind: "time_of_day",
    pattern: words("sunsets?|sundown|sundowners?|tramonto"),
    holds: bySun(
      (sun) => ({ from: sun.set - SUN_MOMENT_MIN, to: sun.set + SUN_MOMENT_MIN }),
      touches,
    ),
  },
  {
    kind: "time_of_day",
    pattern: words("golden hour|golden light"),
    holds: bySun((sun) => ({ from: sun.set - GOLDEN_HOUR_MIN, to: sun.set }), touches),
  },
  {
    kind: "time_of_day",
    pattern: words("dusk|twilight|blue hour|nightfall"),
    holds: bySun((sun) => ({ from: sun.set, to: sun.set + DUSK_SPAN_MIN }), touches),
  },
  {
    kind: "time_of_day",
    pattern: words("sunrises?|dawn|daybreak|first light"),
    holds: bySun(
      (sun) => ({ from: sun.rise - SUN_MOMENT_MIN, to: sun.rise + SUN_MOMENT_MIN }),
      touches,
    ),
  },
];

/** Phrases that name a time of day without claiming it for this stop. */
// Decision: "scenic day or night" describes the place, not the stop's time.
const IDIOMS = words("day and night|night and day|day or night|night or day|any time of day");

/** Single claim words that "or" can join: "lunch or dinner" holds when either does. */
const ALTERNATIVE_WORDS = `day|${LUNCH}|${DINNER}|breakfast|brunch|aperitivo|morning|midday|afternoon|evening|night|sunset|sunrise|daytime`;
const ALTERNATIVES = words(`(?:${ALTERNATIVE_WORDS}) or (?:an? |the )?(?:${ALTERNATIVE_WORDS})`);

// ---------- The check ----------

/** Blank for masked words: not a letter, so no word pattern can match across it. */
const BLANK = "~";

/** Words that do not make a run of name words the name: "by night" is not Trevi by Night. */
const LINKING_WORDS = new Set([
  "the",
  "a",
  "an",
  "at",
  "by",
  "of",
  "in",
  "on",
  "and",
  "to",
  "il",
  "la",
  "le",
  "lo",
  "di",
  "del",
  "della",
  "dei",
  "degli",
  "delle",
  "da",
  "al",
  "alla",
  "e",
]);

/**
 * The normalized reason with the stop's own name blanked where the reason repeats its words in a
 * row, two of them more than linking words ("the", "at", "di").
 */
// Decision: a name is not a claim. "The Last Supper", "Trevi Fountain by night" and "Early
// Morning in Cannaregio" are what the row is called, and derived hours already come from such a
// name. Two words that say something, so a lone "at night" for Piazza Maggiore at Night is still
// checked against its time, and "the last stop" is still a claim at the Last Supper. Other
// places' names never get here (names_other_place drops them first).
export function withoutOwnName(text: string, placeName: string | undefined): string {
  const tokens = foldText(text).split(" ").filter(Boolean);
  const name = foldText(placeName ?? "")
    .split(" ")
    .filter(Boolean);
  const masked = tokens.map(() => false);
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < name.length; j++) {
      let length = 0;
      while (tokens[i + length] !== undefined && tokens[i + length] === name[j + length]) length++;
      const run = tokens.slice(i, i + length);
      if (run.filter((token) => !LINKING_WORDS.has(token)).length < 2) continue;
      for (let k = i; k < i + length; k++) masked[k] = true;
    }
  }
  return tokens.map((token, i) => (masked[i] ? BLANK : token)).join(" ");
}

/** The first rule match in `text` whose claim does not hold, or null. */
function firstMiss(text: string, rules: readonly Rule[], view: View): Contradiction | null {
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      if (!rule.holds(view)) return { kind: rule.kind, claim: match[0] };
    }
  }
  return null;
}

/** `text` with every match of the rules' patterns blanked. */
function blank(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((out, pattern) => out.replace(pattern, BLANK), text);
}

/**
 * The first claim the reason makes about its stop's meal, time of day, or place in the day or the
 * trip that the stop as timed does not bear out, or null when every claim holds.
 */
export function contradictedClaim(
  reason: string,
  where: StopInTrip,
  ctx: PlannerContext,
): Contradiction | null {
  const day = where.days[where.day];
  const stop = day?.stops[where.index];
  if (!day || !stop) return null;
  const place = ctx.placesById.get(stop.placeId);
  let sun: Sun | null | undefined;
  const view: View = {
    stop,
    place,
    stops: day.stops,
    index: where.index,
    day: where.day,
    days: where.days,
    ctx,
    sun: () => {
      if (sun === undefined) sun = place ? sunTimes(place.lat, place.lng, day.date) : null;
      return sun;
    },
  };
  let text = blank(withoutOwnName(reason, place?.name), [IDIOMS]);
  for (const match of text.matchAll(ALTERNATIVES)) {
    const [left = "", right = ""] = match[0].split(" or ");
    const holds = [left, right].some((side) => firstMiss(side, WORD_RULES, view) === null);
    if (!holds) return firstMiss(match[0], WORD_RULES, view);
  }
  text = blank(text, [ALTERNATIVES]);
  const beside = firstMiss(text, BESIDE_RULES, view);
  if (beside) return beside;
  text = blank(
    text,
    BESIDE_RULES.map((rule) => rule.pattern),
  );
  return firstMiss(text, POSITION_RULES, view) ?? firstMiss(text, WORD_RULES, view);
}

// ---------- The sun ----------

const DEGREES = Math.PI / 180;
const DAY_MS = 86_400_000;

/** The date of the last Sunday of a month (1..12). */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/** Italy's clock on the date, in minutes ahead of UTC: CEST from the last Sunday of March. */
// Decision: the EU rule written out, not the Intl time zone database, so the answer does not
// depend on the runtime's ICU data. The change happens at 02:00 or 03:00, so the whole of a
// switch day's plan is on the new clock.
function italyOffsetMin(year: number, month: number, day: number): number {
  const afterMarch = month > 3 || (month === 3 && day >= lastSunday(year, 3));
  const beforeOctober = month < 10 || (month === 10 && day < lastSunday(year, 10));
  return afterMarch && beforeOctober ? 120 : 60;
}

/**
 * Sunrise and sunset at a place on a date, in minutes from local midnight on Italy's clock, or
 * null for a date that cannot be read. The NOAA approximation, within a few minutes in Italy.
 */
export function sunTimes(lat: number, lng: number, date: string): Sun | null {
  const parsed = parseIsoDate(date);
  if (!parsed || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const { year, month, day } = parsed;
  const dayOfYear = (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / DAY_MS;
  const g = (2 * Math.PI * dayOfYear) / 365;
  const equationMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const declination =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const cosHourAngle =
    Math.cos(90.833 * DEGREES) / (Math.cos(lat * DEGREES) * Math.cos(declination)) -
    Math.tan(lat * DEGREES) * Math.tan(declination);
  if (Math.abs(cosHourAngle) > 1) return null; // no sunrise or sunset: never at Italy's latitudes
  const halfDayMin = (4 * Math.acos(cosHourAngle)) / DEGREES;
  const noon = 720 - 4 * lng - equationMin + italyOffsetMin(year, month, day);
  return { rise: Math.round(noon - halfDayMin), set: Math.round(noon + halfDayMin) };
}
