import type { Place, Stop, StopRole } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type { LlmSelection } from "../../src/llm/client";
import { contradictedClaim, sunTimes, type TimedDay } from "../../src/plan/reasonClaims";
import { applyAiReasons } from "../../src/plan/reasons";

// The model writes its reasons before code times the plan, so a reason can claim a meal, a time
// of day, or a place in the day that the timed stop does not have. Each claim is checked both
// ways: kept when the stop bears it out, dropped when it does not. The three live examples come
// from a production plan (Florence, 2026-10-09, balanced, art and food, ai_repaired).

const { ctx } = shippedData();

function byName(name: string): Place {
  const place = ctx.places.find((p) => p.name === name);
  if (!place) throw new Error(`No place named ${name}`);
  return place;
}

const clock = (text: string): number => {
  const [hours = 0, minutes = 0] = text.split(":").map(Number);
  return hours * 60 + minutes;
};

/** A stop at a place from `from` to `to` ("HH:MM"), a visit unless a meal role is given. */
function stop(name: string, from: string, to: string, role: StopRole = "visit"): Stop {
  return {
    placeId: byName(name).id,
    start: clock(from),
    end: clock(to),
    travelFromPrevMin: 10,
    role,
    reason: "Rule reason.",
    reasonSource: "rule",
  };
}

const day = (date: string, anchorId: string, stops: Stop[]): TimedDay => ({
  date,
  anchorId,
  stops,
});

/** What contradicts the reason on stop `index` of day `dayIndex`, or null. */
function claimAt(reason: string, days: TimedDay[], dayIndex: number, index: number) {
  return contradictedClaim(reason, { days, day: dayIndex, index }, ctx);
}

/** The claim check on a one-day trip. */
function claimOn(reason: string, stops: Stop[], index: number, date = "2026-10-09") {
  const anchorId =
    ctx.placesById.get(stops[0]?.placeId ?? "")?.city === "Rome" ? "rome" : "florence";
  return claimAt(reason, [day(date, anchorId, stops)], 0, index);
}

// A day shaped like the live one: its lunch at 13:10, its visit at 17:55 and its dinner at 19:00
// are the production times; the other stops and the restaurants stand in.
const LIVE_DAY = [
  stop("Uffizi Gallery", "09:35", "12:35"),
  stop("Buca Mario", "13:10", "14:40", "lunch"),
  stop("Palazzo Vecchio", "15:00", "16:30"),
  stop("San Miniato al Monte", "17:55", "18:55"),
  stop("Buca dell'Orafo", "19:00", "20:30", "dinner"),
];

describe("the live examples", () => {
  it("drops a dinner reason on the lunch stop", () => {
    const reason = "Splurge-worthy iconic restaurant for a memorable dinner.";
    expect(claimOn(reason, LIVE_DAY, 1)).toEqual({ kind: "meal", claim: "dinner" });
  });

  it("drops a lunch reason on the dinner stop", () => {
    const reason = "Local-favorite restaurant for an authentic Florentine lunch.";
    expect(claimOn(reason, LIVE_DAY, 4)).toEqual({ kind: "meal", claim: "lunch" });
  });

  it("drops morning views on a visit at 17:55", () => {
    const reason = "Historic hilltop church with scenic morning views.";
    expect(claimOn(reason, LIVE_DAY, 3)).toEqual({ kind: "time_of_day", claim: "morning" });
  });

  it("keeps the rule reason on all three and logs why, through applyAiReasons", () => {
    const reasons = [
      "World-class gallery for art lovers.",
      "Splurge-worthy iconic restaurant for a memorable dinner.",
      "Historic palace full of Renaissance art.",
      "Historic hilltop church with scenic morning views.",
      "Local-favorite restaurant for an authentic Florentine lunch.",
    ];
    const selection: LlmSelection = {
      days: [
        {
          anchorId: "florence",
          placeIds: LIVE_DAY.map((s) => s.placeId),
          reasons: LIVE_DAY.map((s, i) => ({ placeId: s.placeId, reason: reasons[i] ?? "" })),
        },
      ],
      summary: "",
    };

    const { days, stats } = applyAiReasons(
      [day("2026-10-09", "florence", LIVE_DAY)],
      selection,
      ctx,
    );

    expect(days[0]?.map((s) => s.reasonSource)).toEqual(["ai", "rule", "ai", "rule", "rule"]);
    expect(days[0]?.[1]?.reason).toBe("Rule reason.");
    expect(stats).toEqual({
      kept: 2,
      replaced: 3,
      rejections: ["wrong_meal", "wrong_time_of_day", "wrong_meal"],
    });
  });
});

describe("meal claims", () => {
  it("keeps lunch on the lunch stop and dinner on the dinner stop", () => {
    expect(claimOn("A hearty Tuscan lunch.", LIVE_DAY, 1)).toBeNull();
    expect(claimOn("A relaxed dinner in Oltrarno.", LIVE_DAY, 4)).toBeNull();
    expect(claimOn("Good for lunch or dinner.", LIVE_DAY, 1)).toBeNull();
  });

  it("drops a meal on a visit, even at a restaurant the scheduler made a visit", () => {
    const day = [stop("Uffizi Gallery", "09:35", "12:35"), stop("Il Latini", "16:45", "17:45")];

    expect(claimOn("Great for lunch nearby.", day, 0)).toMatchObject({ claim: "lunch" });
    expect(claimOn("A convenient midday meal.", day, 1)).toMatchObject({ claim: "meal" });
    expect(claimOn("A convenient midday meal.", LIVE_DAY, 1)).toBeNull();
    expect(claimOn("A hearty supper.", LIVE_DAY, 1)).toMatchObject({ claim: "supper" });
  });

  it("counts an outing under way through a meal as that meal (coversMeal)", () => {
    const ride = [stop("Chianti Day Trip by Bike", "10:50", "18:50")];

    expect(claimOn("Vineyards by bike, with lunch among the hills.", ride, 0)).toBeNull();
    expect(claimOn("Vineyards by bike, ending with dinner.", ride, 0)).toMatchObject({
      claim: "dinner",
    });
  });

  it("checks breakfast, brunch and aperitivo against the stop's time and role", () => {
    const morning = [stop("Mercato Centrale Firenze", "09:30", "10:30")];
    const noon = [stop("Mercato Centrale Firenze", "11:55", "12:55")];
    const evening = [stop("Ponte Vecchio", "18:30", "19:00")];

    expect(claimOn("A Florentine breakfast among the stalls.", morning, 0)).toBeNull();
    expect(claimOn("A Florentine breakfast among the stalls.", noon, 0)).toMatchObject({
      claim: "breakfast",
    });
    expect(claimOn("Lively for brunch.", LIVE_DAY, 1)).toBeNull();
    expect(claimOn("Lively for brunch.", LIVE_DAY, 4)).toMatchObject({ claim: "brunch" });
    expect(claimOn("A bridge made for aperitivo hour.", evening, 0)).toBeNull();
    expect(claimOn("An aperitif with a view.", LIVE_DAY, 1)).toMatchObject({ claim: "aperitif" });
  });

  it("reads meal words in the stop's own name as the name", () => {
    const supper = [stop("The Last Supper (Cenacolo Vinciano)", "09:50", "10:20")];

    expect(
      claimAt("The Last Supper is a must.", [day("2027-01-13", "milan", supper)], 0, 0),
    ).toBeNull();
  });
});

describe("time-of-day claims", () => {
  it("keeps a part of the day the stop fills and drops one it does not", () => {
    expect(claimOn("Best in the morning light.", LIVE_DAY, 0)).toBeNull();
    expect(claimOn("A mid-morning stop.", [stop("Pantheon", "11:00", "11:45")], 0)).toBeNull();
    expect(claimOn("A lively midday lunch.", LIVE_DAY, 1)).toBeNull();
    expect(claimOn("A midday stroll.", [stop("Ponte Vecchio", "15:30", "16:00")], 0)).toMatchObject(
      {
        claim: "midday",
      },
    );
    expect(claimOn("A quiet afternoon visit.", LIVE_DAY, 2)).toBeNull();
    const lateMorning = [stop("Ponte Vecchio", "10:50", "12:20")];
    expect(claimOn("An afternoon walk.", lateMorning, 0)).toMatchObject({ claim: "afternoon" });
  });

  it("counts a stop as evening when half of it is after 18:00", () => {
    expect(claimOn("An evening stroll.", [stop("Ponte Vecchio", "17:45", "18:30")], 0)).toBeNull();
    expect(
      claimOn("An evening stroll.", [stop("Ponte Vecchio", "16:30", "17:00")], 0),
    ).toMatchObject({
      claim: "evening",
    });
    expect(claimOn("A romantic evening meal.", LIVE_DAY, 1)).toMatchObject({ claim: "evening" });
  });

  it("keeps night only after 20:00 and after dark on the stop's date", () => {
    const at = (date: string, from: string, to: string) =>
      claimAt(
        "A fountain that shines at night.",
        [day(date, "rome", [stop("Trevi Fountain by Night", from, to)])],
        0,
        0,
      );

    expect(at("2027-05-20", "21:25", "21:55")).toBeNull();
    expect(at("2026-10-09", "20:00", "20:30")).toBeNull(); // dark since about 19:15
    expect(at("2027-05-19", "20:00", "20:30")).toMatchObject({ claim: "night" }); // sunset 20:26
    expect(claimOn("Lively nightlife all around.", LIVE_DAY, 2)).toMatchObject({
      claim: "nightlife",
    });
    expect(
      claimOn("A late-night stroll.", [stop("Ponte Vecchio", "20:30", "21:00")], 0),
    ).toMatchObject({
      claim: "late night",
    });
  });

  it("reads a last night, a night out and tonight as the evening, not the dark", () => {
    // Sunset in Florence on 20 June 2027 is about 20:55, so a 19:30 dinner is still in daylight.
    const june = [
      stop("Ponte Vecchio", "15:00", "15:30"),
      stop("Il Latini", "19:30", "21:00", "dinner"),
    ];
    const trip = [day("2027-06-19", "florence", june), day("2027-06-20", "florence", june)];

    expect(claimAt("A romantic last night in Florence.", trip, 1, 1)).toBeNull();
    expect(claimAt("A lively night out.", trip, 1, 1)).toBeNull();
    expect(claimAt("Dinner tonight by the river.", trip, 1, 1)).toBeNull();
    expect(claimAt("A lively night out.", trip, 1, 0)).toMatchObject({ claim: "night out" });
    expect(claimAt("Lit up by night.", trip, 1, 1)).toMatchObject({ claim: "night" });
  });

  it("reads after dark and daylight from the sun on the date", () => {
    const stroll = (date: string) =>
      claimAt(
        "The fountain after dark.",
        [day(date, "rome", [stop("Trevi Fountain", "18:30", "19:00")])],
        0,
        0,
      );

    expect(stroll("2026-12-20")).toBeNull(); // sunset 16:41
    expect(stroll("2027-06-20")).toMatchObject({ claim: "after dark" }); // sunset 20:48
    expect(
      claimOn("Worth a daytime visit.", [stop("Ponte Vecchio", "18:00", "18:30")], 0),
    ).toBeNull();
    const december = [day("2026-12-20", "florence", [stop("Ponte Vecchio", "18:00", "18:30")])];
    expect(claimAt("Worth a daytime visit.", december, 0, 0)).toMatchObject({ claim: "daytime" });
  });

  it("keeps sunset, golden hour and dusk only when the stop is under way then", () => {
    const view = (from: string, to: string, date = "2026-10-09") => [
      day(date, "florence", [stop("Piazzale Michelangelo", from, to)]),
    ];

    // Sunset at Piazzale Michelangelo on 9 October 2026 is 18:44.
    expect(claimAt("A romantic sunset view.", view("18:30", "19:00"), 0, 0)).toBeNull();
    expect(claimAt("A romantic sunset view.", view("09:50", "10:20"), 0, 0)).toMatchObject({
      claim: "sunset",
    });
    expect(
      claimAt("A romantic sunset view.", view("18:30", "19:00", "2027-06-20"), 0, 0),
    ).toMatchObject({
      claim: "sunset",
    });
    expect(claimAt("Views in the golden hour.", view("18:00", "18:30"), 0, 0)).toBeNull();
    expect(claimAt("Views in the golden hour.", view("14:00", "14:30"), 0, 0)).not.toBeNull();
    expect(claimAt("The city at dusk.", view("18:45", "19:15"), 0, 0)).toBeNull();
    expect(claimAt("The city at dusk.", view("16:00", "16:30"), 0, 0)).not.toBeNull();
    expect(claimAt("A sundowner with a view.", view("18:30", "19:00"), 0, 0)).toBeNull();
    expect(claimAt("A sundowner with a view.", view("10:35", "11:05"), 0, 0)).toMatchObject({
      claim: "sundowner",
    });
  });

  it("reads before and after sunset as a side of the sunset, not the moment", () => {
    const view = (from: string, to: string) => [
      day("2026-10-09", "florence", [stop("Piazzale Michelangelo", from, to)]),
    ];

    expect(claimAt("The city glows after sunset.", view("21:00", "21:30"), 0, 0)).toBeNull();
    expect(claimAt("The city glows after sunset.", view("14:00", "14:30"), 0, 0)).toMatchObject({
      claim: "after sunset",
    });
    expect(claimAt("Best seen before sunset.", view("16:00", "16:30"), 0, 0)).toBeNull();
    expect(claimAt("Best seen before dark.", view("21:00", "21:30"), 0, 0)).toMatchObject({
      claim: "before dark",
    });
  });

  it("keeps sunrise only around the sunrise of the date", () => {
    const view = (from: string, to: string) => [
      day("2026-10-09", "florence", [stop("Piazzale Michelangelo", from, to)]),
    ];

    expect(claimAt("The city at sunrise.", view("07:00", "07:30"), 0, 0)).toBeNull(); // 07:20
    expect(claimAt("The city at dawn.", view("09:35", "10:05"), 0, 0)).toMatchObject({
      claim: "dawn",
    });
  });

  it("reads the Italian words for the parts of the day and the sunset", () => {
    const morning = [stop("Ponte Vecchio", "11:00", "11:30")];

    expect(claimOn("A passeggiata serale along the river.", morning, 0)).toMatchObject({
      claim: "serale",
    });
    expect(claimOn("Beautiful al tramonto.", morning, 0)).toMatchObject({ claim: "tramonto" });
    expect(claimOn("Un fascino notturno.", morning, 0)).toMatchObject({ claim: "notturno" });
    expect(claimOn("Best di mattina.", morning, 0)).toBeNull();
    expect(claimOn("A lazy pomeriggio.", morning, 0)).toMatchObject({ claim: "pomeriggio" });
  });

  it("does not read words used in another sense as claims", () => {
    const afternoon = [stop("Pantheon", "15:15", "16:00")];
    const bologna = (from: string, to: string) => [
      day("2027-06-20", "bologna", [stop("Piazza Maggiore at Night", from, to)]),
    ];

    expect(claimOn("A photogenic square, scenic day or night.", afternoon, 0)).toBeNull();
    expect(claimOn("Masterpieces of the early Renaissance.", LIVE_DAY, 2)).toBeNull();
    expect(
      claimOn(
        "The final resting place of Michelangelo.",
        [stop("Santa Croce Basilica", "11:00", "12:15"), stop("Ponte Vecchio", "12:30", "13:00")],
        0,
      ),
    ).toBeNull();
    expect(claimOn("A high-end Tuscan restaurant.", LIVE_DAY, 1)).toBeNull();
    // The name repeated is not a claim; "at night" alone for this place is, and 20:00 in June is light.
    expect(
      claimAt("Piazza Maggiore at Night, glowing.", bologna("20:00", "20:30"), 0, 0),
    ).toBeNull();
    expect(claimAt("The square at night.", bologna("20:00", "20:30"), 0, 0)).toMatchObject({
      claim: "night",
    });
  });
});

describe("position claims", () => {
  it("keeps starting the day on the first stop only", () => {
    expect(claimOn("An iconic gallery to start the day.", LIVE_DAY, 0)).toBeNull();
    expect(claimOn("A great morning start.", LIVE_DAY, 0)).toBeNull();
    expect(claimOn("Iconic exterior to start the day.", LIVE_DAY, 3)).toMatchObject({
      kind: "position",
      claim: "to start",
    });
    expect(claimOn("A scenic first stop.", LIVE_DAY, 2)).toMatchObject({ claim: "first stop" });
    expect(
      claimOn(
        "A local market for a morning start.",
        [stop("Buca Mario", "12:00", "13:00", "lunch")],
        0,
      ),
    ).toMatchObject({
      kind: "time_of_day",
      claim: "morning",
    });
  });

  it("keeps starting to explore on the day's first visit, after an arrival lunch", () => {
    const arrival = [
      stop("Buca dell'Orafo", "12:00", "13:30", "lunch"),
      stop("Ponte Vecchio", "13:50", "14:20"),
      stop("Uffizi Gallery", "14:50", "17:50"),
    ];

    expect(claimOn("A classic bridge to start exploring Florence.", arrival, 1)).toBeNull();
    expect(claimOn("A great gallery to start exploring Florence.", arrival, 2)).toMatchObject({
      claim: "start exploring",
    });
  });

  it("keeps ending the day on the last stop only", () => {
    expect(claimOn("A classic trattoria to end the day.", LIVE_DAY, 4)).toBeNull();
    expect(claimOn("A classic trattoria to end the day.", LIVE_DAY, 1)).toMatchObject({
      claim: "end the day",
    });
    expect(claimOn("A sweet treat to cap off the day.", LIVE_DAY, 2)).not.toBeNull();
    expect(claimOn("The perfect last stop.", LIVE_DAY, 3)).toMatchObject({ claim: "last stop" });
    expect(claimOn("Close to the last stop.", LIVE_DAY, 3)).toBeNull();
  });

  it("reads the other ways to say a day starts or ends", () => {
    for (const reason of [
      "A relaxed wrap-up to the day.",
      "Perfect as the day winds down.",
      "The perfect finale.",
      "The day's grand finale.",
      "A great way to round out the day.",
    ]) {
      expect(claimOn(reason, LIVE_DAY, 4), reason).toBeNull();
      expect(claimOn(reason, LIVE_DAY, 2), reason).toMatchObject({ kind: "position" });
    }
    expect(claimOn("A perfect kick-off to the day.", LIVE_DAY, 0)).toBeNull();
    expect(claimOn("A perfect kick-off to the day.", LIVE_DAY, 2)).toMatchObject({
      claim: "kick off to the day",
    });
    expect(claimOn("A never-ending feast of frescoes.", LIVE_DAY, 2)).toBeNull();
  });

  it("checks the trip's first and last days", () => {
    const trip = [
      day("2026-10-09", "florence", LIVE_DAY),
      day("2026-10-10", "florence", LIVE_DAY),
      day("2026-10-11", "florence", LIVE_DAY),
    ];

    expect(claimAt("A memorable final dinner.", trip, 2, 4)).toBeNull();
    expect(claimAt("A memorable final dinner.", trip, 0, 4)).toMatchObject({
      claim: "final dinner",
    });
    expect(claimAt("A trattoria to end the trip.", trip, 2, 4)).toBeNull();
    expect(claimAt("A trattoria to end the trip.", trip, 1, 4)).toMatchObject({
      claim: "end the trip",
    });
    expect(claimAt("A farewell dinner.", trip, 0, 4)).toMatchObject({ claim: "farewell" });
    expect(claimAt("A gallery to start your trip.", trip, 0, 0)).toBeNull();
    expect(claimAt("A gallery to start your trip.", trip, 1, 0)).not.toBeNull();
  });

  it("checks first and last at a base when the trip moves", () => {
    const rome = [
      stop("Pantheon", "10:00", "10:45"),
      stop("Roscioli Salumeria", "19:30", "21:00", "dinner"),
    ];
    const trip = [
      day("2026-10-09", "florence", LIVE_DAY),
      day("2026-10-10", "rome", rome),
      day("2026-10-11", "rome", rome),
    ];

    expect(claimAt("A lively first evening in Rome.", trip, 1, 1)).toBeNull();
    expect(claimAt("A lively first evening in Rome.", trip, 2, 1)).not.toBeNull();
    expect(claimAt("A first taste of Rome.", trip, 1, 0)).toBeNull();
    expect(claimAt("A first taste of Rome.", trip, 2, 0)).toMatchObject({ claim: "first taste" });
  });

  it("reads a first or last of the trip, or in Italy, as the trip's, not the base's", () => {
    const rome = [
      stop("Pantheon", "10:00", "10:45"),
      stop("Roscioli Salumeria", "19:30", "21:00", "dinner"),
    ];
    const trip = [
      day("2026-10-09", "rome", rome),
      day("2026-10-10", "rome", rome),
      day("2026-10-11", "florence", LIVE_DAY),
    ];

    expect(claimAt("A memorable last night of the trip.", trip, 1, 1)).toMatchObject({
      claim: "last night of the trip",
    });
    expect(claimAt("A memorable last night in Rome.", trip, 1, 1)).toBeNull();
    expect(claimAt("Your first evening in Italy.", trip, 2, 4)).toMatchObject({
      claim: "first evening in italy",
    });
    expect(claimAt("Your first evening in Italy.", trip, 0, 1)).toBeNull();
    expect(claimAt("A grand first day of the trip.", trip, 2, 0)).not.toBeNull();
  });

  it("keeps before and after a meal only next to it", () => {
    const rome = [
      stop("Colosseum", "09:40", "11:40"),
      stop("Roscioli Salumeria", "12:15", "13:45", "lunch"),
      stop("Trevi Fountain", "14:05", "14:35"),
      stop("Pantheon", "17:30", "18:15"),
      stop("Trevi Fountain by Night", "20:00", "20:30"),
    ];
    const withDinner = [...rome.slice(0, 4), stop("Buca Mario", "19:00", "20:40", "dinner")];

    expect(claimOn("An arena to see before lunch.", rome, 0)).toBeNull();
    expect(claimOn("A quick visit after lunch.", rome, 2)).toBeNull();
    expect(claimOn("A quick visit after lunch.", rome, 3)).toMatchObject({ claim: "after lunch" });
    expect(claimOn("A calm stop before dinner.", withDinner, 3)).toBeNull();
    expect(claimOn("A calm stop before dinner.", withDinner, 2)).toMatchObject({
      claim: "before dinner",
    });
    expect(claimOn("On the way to dinner.", withDinner, 3)).toBeNull();
    expect(claimOn("A stroll between lunch and dinner.", withDinner, 2)).toBeNull();
    expect(claimOn("A stroll between lunch and dinner.", withDinner, 0)).not.toBeNull();
  });

  it("keeps an after-dinner stop only after dinner", () => {
    const evening = [
      stop("Roscioli Salumeria", "19:30", "21:00", "dinner"),
      stop("Trevi Fountain by Night", "21:25", "21:55"),
    ];
    const trip = [day("2026-10-09", "rome", evening)];

    expect(claimAt("An after-dinner stroll to the fountain.", trip, 0, 1)).toBeNull();
    expect(claimAt("An after-dinner stroll to the fountain.", trip, 0, 0)).not.toBeNull();
    expect(claimAt("A nightcap of a view.", trip, 0, 1)).toBeNull();
    expect(claimAt("A stroll dopo cena.", trip, 0, 1)).toBeNull();
    expect(claimAt("A stroll dopo cena.", trip, 0, 0)).toMatchObject({ claim: "dopo cena" });
  });

  it("checks museums before and after, and the day before a dinner", () => {
    const ride = [
      stop("Chianti Day Trip by Bike", "10:50", "18:50"),
      stop("Il Latini", "19:50", "21:50", "dinner"),
    ];

    expect(
      claimOn(
        "Market browsing before the museums.",
        [stop("Mercato Centrale Firenze", "09:45", "10:45"), ...LIVE_DAY.slice(2)],
        0,
      ),
    ).toBeNull();
    expect(claimOn("Market browsing before the museums.", LIVE_DAY, 3)).toMatchObject({
      claim: "before the museums",
    });
    expect(claimOn("Gardens to unwind after museum visits.", LIVE_DAY, 3)).toBeNull();
    expect(claimOn("Dinner after a day of cycling.", ride, 1)).toBeNull();
    expect(claimOn("Rest after a day of cycling.", ride, 0)).not.toBeNull();
    expect(claimOn("Lunch after a morning of museums.", LIVE_DAY, 1)).toBeNull();
  });
});

describe("sunTimes", () => {
  const minutes = (time: string) => clock(time);

  it("is within five minutes of published sunrise and sunset", () => {
    const cases = [
      { lat: 41.9028, lng: 12.4964, date: "2026-12-21", rise: "07:34", set: "16:42" }, // Rome
      { lat: 45.4642, lng: 9.19, date: "2026-06-21", rise: "05:35", set: "21:15" }, // Milan
      { lat: 43.7696, lng: 11.2558, date: "2026-10-09", rise: "07:21", set: "18:45" }, // Florence
    ];
    for (const { lat, lng, date, rise, set } of cases) {
      const sun = sunTimes(lat, lng, date);
      expect(Math.abs((sun?.rise ?? 0) - minutes(rise)), date).toBeLessThanOrEqual(5);
      expect(Math.abs((sun?.set ?? 0) - minutes(set)), date).toBeLessThanOrEqual(5);
    }
  });

  it("moves the clock back an hour on the last Sunday of October", () => {
    const saturday = sunTimes(41.9028, 12.4964, "2026-10-24");
    const sunday = sunTimes(41.9028, 12.4964, "2026-10-25");

    expect((saturday?.set ?? 0) - (sunday?.set ?? 0)).toBeGreaterThan(55);
    expect(sunTimes(41.9, 12.5, "2026-02-30")).toBeNull();
  });
});
