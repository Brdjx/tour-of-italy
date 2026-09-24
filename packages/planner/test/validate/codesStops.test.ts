import { describe, expect, it } from "vitest";
import { validateItinerary } from "../../src/validate";
import { ctx, dayOf, errorCodes, key, miniTrip, stopOf, withCode } from "./fixtures";
import { stop } from "./trips";

// One test per stop-level code, each on the mini trip (Rome, Rome, Florence from Tue 20 Oct
// 2026) with one change and the exact list of errors asserted.

describe("which place a stop is", () => {
  it("rejects an invented place id (UNKNOWN_PLACE)", () => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).placeId = "place_999";
    expect(errorCodes(plan)).toEqual(["UNKNOWN_PLACE"]);
    expect(withCode(plan, "UNKNOWN_PLACE")[0]).toMatchObject({
      day: 1,
      stopIndex: 0,
      placeId: "place_999",
    });
  });

  it("rejects the same place twice in one trip (DUPLICATE_PLACE)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops = [stop("place_005", 600, 645, 5, "visit")]; // Pantheon again
    expect(errorCodes(plan)).toEqual(["DUPLICATE_PLACE"]);
    expect(withCode(plan, "DUPLICATE_PLACE")[0]?.detail).toBe(
      "Pantheon is already in this trip on day 1.",
    );
  });

  it("rejects a place the traveler excluded (EXCLUDED_PLACE)", () => {
    const plan = miniTrip({ exclude: ["place_001"] });
    expect(errorCodes(plan)).toEqual(["EXCLUDED_PLACE"]);
    expect(withCode(plan, "EXCLUDED_PLACE")[0]?.detail).toBe("You asked to leave out Colosseum.");
  });

  it("rejects a Rome place on a Florence day (OUTSIDE_ANCHOR)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops = [stop("place_026", 720, 900, 130, "visit")]; // Uffizi, from Rome
    expect(errorCodes(plan)).toEqual(["OUTSIDE_ANCHOR"]);
    expect(withCode(plan, "OUTSIDE_ANCHOR")[0]?.detail).toBe(
      "Uffizi Gallery belongs to the Florence base, but day 2 is based in Rome.",
    );
  });

  it("rejects a meal at a place that serves no meals (NOT_A_MEAL_PLACE)", () => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).start = 720; // Colosseum 12:00 to 14:00, labelled lunch
    stopOf(plan, 1, 0).end = 840;
    stopOf(plan, 1, 0).role = "lunch";
    expect(errorCodes(plan)).toEqual(["NOT_A_MEAL_PLACE"]);
    expect(withCode(plan, "NOT_A_MEAL_PLACE")[0]?.detail).toBe("Colosseum does not serve lunch.");
  });
});

describe("stop times", () => {
  it.each([
    ["a fractional minute", 600.5, 720.5],
    ["an end before the start", 720, 600],
    ["an end equal to the start", 600, 600],
    ["a time past 06:00 the next morning", 1700, 1820],
    ["a negative start", -120, 0],
    ["a NaN start", Number.NaN, 720],
    ["an infinite end", 600, Number.POSITIVE_INFINITY],
  ])("rejects %s (INVALID_TIME)", (_label, start, end) => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).start = start;
    stopOf(plan, 1, 0).end = end;
    expect(errorCodes(plan)).toEqual(["INVALID_TIME"]);
  });

  it("rejects a visit shorter than the place's visit length (INVALID_TIME)", () => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).end = 660; // a 1-hour Colosseum
    expect(errorCodes(plan)).toEqual(["INVALID_TIME"]);
    expect(withCode(plan, "INVALID_TIME")[0]?.detail).toBe(
      "Colosseum is planned for 1 h, but a visit takes 2 h.",
    );
  });

  it("rejects a visit past closing time (CLOSED_AT_TIME)", () => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).start = 1080; // Colosseum 18:00 to 20:00, it closes at 19:00
    stopOf(plan, 1, 0).end = 1200;
    expect(errorCodes(plan)).toEqual(["CLOSED_AT_TIME"]);
    expect(withCode(plan, "CLOSED_AT_TIME")[0]?.detail).toBe(
      "Colosseum is open 09:00 to 19:00 on Wed 21 Oct 2026, but this visit runs 18:00 to 20:00.",
    );
  });

  it("rejects a Borghese Gallery visit on its closed Monday (CLOSED_AT_TIME)", () => {
    const plan = miniTrip({ startDate: "2026-10-19" });
    ["2026-10-19", "2026-10-20", "2026-10-21"].forEach((date, i) => {
      dayOf(plan, i).date = date;
    });
    dayOf(plan, 0).stops = [stop("place_007", 600, 720, 20, "visit")]; // Borghese Gallery
    expect(errorCodes(plan)).toEqual(["CLOSED_AT_TIME"]);
    expect(withCode(plan, "CLOSED_AT_TIME")[0]?.detail).toBe(
      "Borghese Gallery is closed on Mondays.",
    );
  });

  it("rejects a seasonal place out of season, not as a time problem (SEASONAL_CLOSED)", () => {
    const plan = miniTrip({ startDate: "2026-11-03" }); // same weekdays, one week into November
    ["2026-11-03", "2026-11-04", "2026-11-05"].forEach((date, i) => {
      dayOf(plan, i).date = date;
    });
    dayOf(plan, 2).stops = [stop("place_035", 750, 1230, 50, "visit")]; // Chianti by bike
    expect(errorCodes(plan)).toEqual(["SEASONAL_CLOSED"]);
    expect(withCode(plan, "SEASONAL_CLOSED")[0]?.detail).toBe(
      "Chianti Day Trip by Bike is closed on Thu 5 Nov 2026 (Open April-October only).",
    );
  });

  it("rejects the Parma tour on a Saturday, its date rule says weekdays only (SEASONAL_CLOSED)", () => {
    const plan = miniTrip({ startDate: "2026-10-22" });
    ["2026-10-22", "2026-10-23", "2026-10-24"].forEach((date, i) => {
      dayOf(plan, i).date = date;
    });
    const day = dayOf(plan, 2);
    day.anchorId = "bologna";
    day.transferMin = 155; // Rome to Bologna
    day.stops = [stop("place_053", 830, 1190, 105, "visit")]; // Cheese and Prosciutto Tour
    expect(errorCodes(plan)).toEqual(["SEASONAL_CLOSED"]);
    expect(withCode(plan, "SEASONAL_CLOSED")[0]?.detail).toContain("weekday mornings only");
  });

  it("rejects a stop that starts before the next one can be reached (OVERLAP)", () => {
    const plan = miniTrip();
    stopOf(plan, 0, 0).start = 700; // Pantheon 11:40 to 12:25; Roscioli at 12:30 leaves 5 min
    stopOf(plan, 0, 0).end = 745;
    expect(errorCodes(plan)).toEqual(["OVERLAP"]);
    expect(withCode(plan, "OVERLAP")[0]?.detail).toBe(
      "Roscioli Salumeria starts at 12:30, but Pantheon ends at 12:25, 10 min away, plus 10 min to spare, so 12:45 is the earliest start.",
    );
  });

  it("rejects a stop listed before an earlier one (OVERLAP)", () => {
    const plan = miniTrip();
    dayOf(plan, 0).stops.reverse();
    stopOf(plan, 0, 0).travelFromPrevMin = 5; // Roscioli from the base, Pantheon from Roscioli
    stopOf(plan, 0, 1).travelFromPrevMin = 10;
    expect(errorCodes(plan)).toEqual(["OVERLAP"]);
  });

  it("rejects travel claims that do not match the travel model (WRONG_TRAVEL)", () => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).travelFromPrevMin = 5; // Colosseum is 20 min from the Rome base
    stopOf(plan, 0, 1).travelFromPrevMin = 0.5;
    expect(errorCodes(plan)).toEqual(["WRONG_TRAVEL", "WRONG_TRAVEL"]);
    expect(withCode(plan, "WRONG_TRAVEL")[1]?.detail).toBe(
      "Colosseum lists 5 min of travel from the Rome base, but it is 20 min away.",
    );
  });
});

describe("day and meal windows", () => {
  it("rejects a stop before the day starts (OUTSIDE_DAY_WINDOW)", () => {
    const plan = miniTrip();
    stopOf(plan, 1, 0).start = 540; // Colosseum at 09:00, a balanced day starts at 09:30
    stopOf(plan, 1, 0).end = 660;
    expect(errorCodes(plan)).toEqual(["OUTSIDE_DAY_WINDOW"]);
  });

  it("rejects a stop that ends after the day ends (OUTSIDE_DAY_WINDOW)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops = [stop("place_077", 1335, 1365, 15, "visit")]; // Trevi by Night 22:15
    expect(errorCodes(plan)).toEqual(["OUTSIDE_DAY_WINDOW"]);
    expect(withCode(plan, "OUTSIDE_DAY_WINDOW")[0]?.detail).toBe(
      "Trevi Fountain by Night runs 22:15 to 22:45, outside this balanced day, which runs 09:30 to 22:30.",
    );
  });

  it("rejects a first stop the traveler cannot reach from the base in time (OUTSIDE_DAY_WINDOW)", () => {
    const plan = miniTrip();
    stopOf(plan, 2, 0).start = 700; // 11:40 is when the train arrives; the square is 10 min away
    stopOf(plan, 2, 0).end = 730;
    expect(errorCodes(plan)).toEqual(["OUTSIDE_DAY_WINDOW"]);
    expect(withCode(plan, "OUTSIDE_DAY_WINDOW")[0]?.detail).toContain(
      "11:50 is the earliest start",
    );
  });

  it("rejects a dinner that ends after the day ends, meals included (OUTSIDE_DAY_WINDOW)", () => {
    const plan = miniTrip();
    // Roscioli as dinner at 21:30, the latest dinner start, ends at 23:00, after 22:30
    Object.assign(stopOf(plan, 0, 1), { start: 1290, end: 1380, role: "dinner" });
    expect(errorCodes(plan)).toEqual(["OUTSIDE_DAY_WINDOW"]);
  });

  it("rejects lunch at 16:00 (MEAL_OUTSIDE_WINDOW)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops.push(stop("place_020", 960, 1050, 20, "lunch")); // Il Sorpasso
    expect(errorCodes(plan)).toEqual(["MEAL_OUTSIDE_WINDOW"]);
    expect(withCode(plan, "MEAL_OUTSIDE_WINDOW")[0]?.detail).toBe(
      "Lunch at Il Sorpasso starts at 16:00, but lunch must start between 12:00 and 14:30.",
    );
  });

  it("rejects dinner at 18:00 (MEAL_OUTSIDE_WINDOW)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops.push(stop("place_020", 1080, 1170, 20, "dinner"));
    expect(errorCodes(plan)).toEqual(["MEAL_OUTSIDE_WINDOW"]);
  });
});

describe("warnings that travel with a valid plan", () => {
  it("warns when hours are unknown (HOURS_UNKNOWN)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops = [stop("place_021", 600, 840, 25, "visit")]; // Appian Way bike ride
    expect(errorCodes(plan)).toEqual([]);
    expect(withCode(plan, "HOURS_UNKNOWN").map(key)).toEqual(["HOURS_UNKNOWN 1 place_021"]);
  });

  it("warns about a place over the budget (OVER_BUDGET)", () => {
    const plan = miniTrip({ maxPriceLevel: 2 });
    expect(errorCodes(plan)).toEqual([]);
    expect(withCode(plan, "OVER_BUDGET")[0]?.detail).toBe(
      "Roscioli Salumeria is €€€, over your limit of €€.",
    );
  });

  it("warns about a low-rated place (LOW_RATING)", () => {
    const plan = miniTrip();
    dayOf(plan, 0).stops[1] = stop("place_025", 750, 840, 15, "lunch"); // Hard Rock Cafe
    expect(errorCodes(plan)).toEqual([]);
    expect(withCode(plan, "LOW_RATING").map(key)).toEqual(["LOW_RATING 0 place_025"]);
  });

  it("warns when two stops are the same spot (SAME_LOCATION)", () => {
    const plan = miniTrip();
    dayOf(plan, 0).stops.push(stop("place_018", 865, 895, 15, "visit")); // Trevi Fountain
    dayOf(plan, 1).stops.push(stop("place_077", 1200, 1230, 20, "visit")); // Trevi by Night
    const same = validateItinerary(plan, ctx()).filter((v) => v.code === "SAME_LOCATION");
    expect(errorCodes(plan)).toEqual([]);
    expect(same.map(key)).toEqual(["SAME_LOCATION 1 place_077"]);
    expect(same[0]?.detail).toBe(
      "Trevi Fountain by Night is at the same spot as Trevi Fountain, which is also in this trip.",
    );
  });
});
