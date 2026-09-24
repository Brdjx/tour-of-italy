// Tunables for the rules-only planner (planDeterministic, scheduleDay's greedy walk, swaps). Data
// and travel tunables, and every hard rule, live in config.ts; these only shape how the greedy
// planner walks a day and chooses bases. The validator never reads them: an AI plan or an edit
// that ignores them is still valid, only less polished. Change a value, run `pnpm check`, and
// the planner tests show what moved.

/** Minutes from midnight for a clock time, so the tables below read like a timetable. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

/**
 * A stop that can start within this many minutes of arriving counts as "available now". The
 * greedy walk prefers available stops and only waits longer when nothing else can happen.
 */
// Decision: 30 minutes. Shorter makes lunch at 12:00 lose to a visit that ends at 12:40 and a
// long wait later; longer lets a meal or a late-opening museum idle the traveler for an hour.
export const MAX_IDLE_MIN = 30;

/**
 * The evening starts here for waiting: a wait before a stop that starts at or after this time is
 * the traveler resting before the evening, like the wait for dinner, not a gap in the plan.
 */
// Decision: 18:00, when the data's evening-only places open ("Evenings"). A day that ends its
// sights at 15:00 and meets again for Piazza Maggiore by night at 20:00 has no gap to fix; a
// morning with nothing from 09:35 to 12:00 does (dayShape.ts, longestWait).
export const EVENING_FROM = at(18);

/**
 * A morning visit the day can still start now, that no later day of the trip can still hold, and
 * that the day's best pick would push past its latest start, is taken first when its score is
 * within this many points of that best pick (dayPicks.ts, lastChance).
 */
// Decision: 0.3 points, about 6 km of the distance term or a fifth of a star. From the middle of
// Rome the Vatican Museums (an outing, so a morning start) score 0.13 below the Pantheon only for
// the walk; a Rome trip starting on a Sunday has two open mornings, lost them both to sights open
// all week, and never included the Vatican (0 of 312 trips). A clearly weaker place still loses.
export const LAST_CHANCE_MARGIN = 0.3;

/**
 * A meal place reached when it could also be visited takes a meal role only if that meal can
 * start within this many minutes of the visit's start (see inferRole).
 */
// Decision: 60 minutes. A market reached at 09:45 is a morning visit, not a lunch two hours
// later; a restaurant reached at 11:30 is lunch at 12:00; a must-include restaurant after the
// day's lunch and dinner are taken can still be an afternoon visit.
export const MEAL_WAIT_MAX_MIN = 60;

/**
 * When the planner chooses bases itself, it compares full trips for this many of the
 * highest-ranked bases (each alone, and each pair in both orders and every day split).
 */
// Decision: 3 of the 5 bases, plus any base holding a must-include (automaticTiers), so the list
// never hides one; the remaining bases are only tried when no shortlisted trip can fill every day.
export const ANCHOR_SHORTLIST = 3;

/**
 * What a change of base costs a trip, in score points: a fixed cost for packing up and moving
 * hotel, plus a cost per hour on the train, plus a surcharge on a relaxed trip for a transfer
 * longer than LONG_TRANSFER_MIN. A second base must add more than this to be chosen.
 */
// Decision: about a day of well-rated places for the move (10) plus 1.5 per hour. Measured over
// every third day of 2026 and 2027: a plain request now stays in one base at every pace (it used
// to take two in 100% of trips, 29% with a 3-hour train), while a second base that holds a
// must-include (worth 100) or a day of interest matches (about 3 each: art on a packed trip)
// still earns its transfer. The relaxed surcharge keeps a relaxed trip off a 3-hour train unless
// the traveler asked for a place at the other end.
export const TRANSFER_COST = { perMove: 10, perHour: 1.5, relaxedLongTransfer: 10 } as const;

/**
 * What a must-include timed against a day rule (an outing after noon, a park after sunset) costs
 * a trip when the planner compares arrangements of bases, in score points.
 */
// Decision: 20, twice a change of base. Among trips that keep the same must-includes, one that
// times them well wins over one that saves a move; the must-include itself is never dropped.
export const MISTIMED_MUST_COST = 20;

/** A long outing (see OUTING_MIN_MINUTES) is the morning anchor: it starts by this time. */
// Decision: noon. A day trip that starts at 17:15 gets back after midnight; by noon every day
// trip in the data fits at every pace (Pienza from Florence starts 11:45 on a relaxed day) and
// lunch happens during it. This also reads the Parma tour's "weekday mornings only" note.
export const OUTING_LATEST_START = at(12);

/** The traveler leaves for the day's first stop outside the base city by this time. */
// Decision: 15:00, a half-day trip after lunch. Modena for a tasting after lunch still gets the
// traveler back to Bologna for dinner; leaving Milan for Lake Como at 16:00 does not.
export const LEAVE_TOWN_BY = at(15);

/**
 * Approximate sunset in Italy by month (January first), local clock time. Parks and outdoor
 * experiences are planned to end by then.
 */
// Decision: one table for the whole country, rounded down to the quarter hour. Sunset differs by
// about 20 minutes between Milan and Rome, which matters less than a park visit at 18:00 in
// January. Viewpoints and neighborhoods are left out on purpose: "by Night" places exist.
export const SUNSET_BY_MONTH: readonly number[] = [
  at(17), // Jan
  at(17, 30), // Feb
  at(18, 15), // Mar
  at(19, 45), // Apr
  at(20, 15), // May
  at(20, 45), // Jun
  at(20, 45), // Jul
  at(20, 15), // Aug
  at(19, 15), // Sep
  at(18, 15), // Oct
  at(16, 45), // Nov
  at(16, 30), // Dec
];

/**
 * Places outside the base city that one day may combine: each within this distance of every
 * other out-of-town stop that day. Modena and Maranello (14 km) go together; Maranello and Isola
 * della Scala (83 km, another direction) do not.
 */
export const SATELLITE_AREA_KM = 25;

/** A name that marks a pre-dinner stop (an aperitivo), never planned after dinner. */
export const PRE_DINNER_NAME = /\baperitivo\b/i;

/** An aperitivo visit starts no earlier than this, whatever its listed hours. */
// Decision: 17:00, just before the aperitivo window the data policy reads from the name (17:30
// to 21:00). Listed hours say when a rooftop bar opens (Ceresio 7 at 12:30), not when its
// aperitivo happens: all 901 Milan plans with Ceresio 7 had it before 17:00, most at lunchtime.
export const APERITIVO_EARLIEST_START = at(17);

/** A name that marks an afternoon or evening treat (gelato, a wine bar), never before noon. */
// Decision: a wine bar joins gelato. Enoteca al Volto opens at 10:00 and was the first stop of
// the day in 314 of 697 Venice plans; a glass of wine with cicchetti belongs after noon.
export const AFTER_NOON_NAME = /\b(gelato|enoteca)\b/i;
export const TREAT_EARLIEST_START = at(12);

/** A tasting with no listed hours ends by DAYTIME_LATEST_END: a producer's working day. */
// Decision: the balsamic vinegar tasting in Modena has no hours and was planned at 18:40 to
// 20:10, while Acetaia Giusti next door closes at 18:00. Listed hours always win over this.
export const DAYTIME_NAME = /\btasting\b/i;
export const DAYTIME_LATEST_END = at(18);

/**
 * Dates most museums and ticketed sites in Italy close (25 December, 1 January). The planner
 * does not suggest a museum or a historic site with listed hours on these dates.
 */
// Decision: a preference, not a hard rule. The data has no holiday hours, so the validator, the
// AI path, and a place the traveler adds by hand are unchanged; the rules-only plan simply stops
// sending travelers to the Colosseum on Christmas Day. A closed guess only hides an option. A
// must-include goes on another day at its base when one can hold it (tripWalk.ts), and on the
// holiday only when none can.
export const HOLIDAY_CLOSURES: readonly { month: number; day: number }[] = [
  { month: 12, day: 25 },
  { month: 1, day: 1 },
];

/** Default meta.generatedAt when the caller injects no clock. Fixed so output is reproducible. */
// Decision: the Unix epoch rather than Date.now(). The planner is pure; the API passes a clock.
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
