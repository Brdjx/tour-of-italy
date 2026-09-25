import { hoursOn, type Place, tripDates } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { placeFacts, rangesText, type StopFactSheet, stopFacts, weekRows } from "../lib/stopFacts";
import { must, places } from "./fixtures";

// A stop's details sheet states facts for its date. The hours must be the planner's own answer
// (the one the scheduler and validator use), what the data cannot confirm must be said with the
// listing's own words, and our sentences must never be confused with the listing's.

const TUESDAY = "2026-10-06";
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-04";

function place(id: string): Place {
  return must(
    places.find((item) => item.id === id),
    id,
  );
}

function sheet(id: string, date = TUESDAY, start = 600, end = 660): StopFactSheet {
  return stopFacts(place(id), date, { start, end });
}

function fact(result: StopFactSheet, key: string) {
  return must(
    result.facts.find((item) => item.key === key),
    key,
  );
}

describe("stopFacts: hours on the date", () => {
  it("gives the listed hours for that weekday, every range, as clock times", () => {
    const hours = fact(sheet("place_003"), "hours"); // Da Enzo, Mon-Sat lunch and dinner
    expect(hours.label).toBe("Hours on Tue 6 Oct");
    expect(hours.value).toBe("12:30 to 14:30 and 19:30 to 22:30");
    expect(hours.numeric).toBe(true);
  });

  it("says a place is closed on its weekly closing day", () => {
    expect(fact(sheet("place_003", SUNDAY), "hours").value).toBe("Closed on Sundays");
    expect(fact(sheet("place_007", MONDAY), "hours").value).toBe("Closed on Mondays");
  });

  it("names the listing's rule when a season or date rule closes it", () => {
    const winter = sheet("place_064", "2026-11-10"); // Villa del Balbianello, April to October
    expect(fact(winter, "hours").value).toBe(
      'Closed on this date, the listing says "Open April-October only"',
    );
    expect(fact(winter, "dates").value).toMatch(/^Open Apr to Oct/);
    // Brera Antique Market: the third weekend of each month only.
    expect(fact(sheet("place_059"), "hours").value).toContain("Third weekend of each month only");
    expect(fact(sheet("place_059", "2026-10-17"), "hours").value).toBe("09:00 to 19:00");
  });

  it("checks the planned visit against the hours, the same check the validator runs", () => {
    const colosseum = "place_001"; // 09:00 to 19:00
    expect(fact(sheet(colosseum, TUESDAY, 540, 660), "hours").note).toBe(
      "Your visit fits inside these hours.",
    );
    expect(fact(sheet(colosseum, TUESDAY, 1100, 1200), "hours").note).toBe(
      "Your visit does not fit inside these hours.",
    );
    expect(fact(sheet("place_038"), "hours").note).toBeNull(); // unknown hours: no claim
  });

  it("agrees with the planner's hours for every place on every trip date", () => {
    for (const item of places) {
      for (const date of tripDates(TUESDAY)) {
        const hours = fact(stopFacts(item, date, { start: 600, end: 660 }), "hours");
        const ranges = hoursOn(item, date);
        if (ranges === "unknown") expect(hours.value, item.id).toBe("Not in the data");
        else if (ranges.length === 0) expect(hours.value, item.id).toMatch(/^Closed on /);
        else if (item.hoursConfidence === "open_access")
          expect(hours.value, item.id).toBe("No set hours");
        else expect(hours.value, item.id).toContain(rangesText(ranges));
      }
    }
  });

  it("never throws on a bad date", () => {
    const result = sheet("place_001", "not-a-date");
    expect(fact(result, "hours").value).toBe("Not known for this date");
  });
});

describe("stopFacts: what the data cannot confirm", () => {
  it("quotes the listing's words for hours it gives only in words", () => {
    const result = sheet("place_037"); // Aperitivo at Rasputin: "Evenings"
    expect(fact(result, "hours").value).toBe("18:00 to 24:00, estimated");
    const caveat = must(result.unconfirmed.find((item) => item.key === "hours"));
    expect(caveat.text).toContain("estimated here as 18:00 to 24:00");
    expect(caveat.quote).toBe("Evenings");
  });

  it("says when hours are estimated from the place's name, quoting the words it used", () => {
    const caveat = must(sheet("place_052").unconfirmed.find((item) => item.key === "hours"));
    expect(caveat.text).toContain("from its name");
    expect(caveat.quote).toBe("at Night");
  });

  it("explains a public space's planned window and missing hours", () => {
    const open = sheet("place_018"); // Trevi Fountain
    expect(fact(open, "hours").value).toBe("No set hours");
    expect(open.unconfirmed[0]?.text).toContain("planned between 07:00 and 23:00");
    const unknown = sheet("place_038"); // Siena Day Trip
    expect(fact(unknown, "hours").value).toBe("Not in the data");
    expect(unknown.unconfirmed[0]).toEqual({
      key: "hours",
      text: "The listing gives no opening hours. Check them before you go.",
      quote: null,
    });
  });

  it("lists an approximate location, a stricter rule, an estimated length and a price conflict", () => {
    const brera = sheet("place_059").unconfirmed.map((item) => item.key);
    expect(brera).toEqual(expect.arrayContaining(["location", "hours_conflict", "seasonal_note"]));
    expect(sheet("place_059").unconfirmed.find((item) => item.key === "location")?.text).toContain(
      "near the middle of Brera",
    );
    expect(sheet("place_014").unconfirmed.find((item) => item.key === "duration")?.text).toContain(
      "a typical time for a viewpoint",
    );
    expect(sheet("place_007").unconfirmed.find((item) => item.key === "price")?.text).toBe(
      "Tagged splurge but priced €€. The plan uses the listed price.",
    );
  });

  it("quotes the seasonal note exactly as the listing wrote it", () => {
    const note = sheet("place_001").unconfirmed.find((item) => item.key === "seasonal_note");
    expect(note?.quote).toBe(place("place_001").seasonalNote);
  });

  it("has nothing to add for a place whose data is complete", () => {
    expect(sheet("place_003").unconfirmed).toEqual([]);
  });
});

describe("stopFacts: booking, price and the description", () => {
  it("states booking with its basis", () => {
    expect(fact(sheet("place_001"), "booking").value).toBe(
      "Required, says the listing. Book before you go.",
    );
    expect(fact(sheet("place_015"), "booking").value).toBe("Not required, says the listing");
    expect(fact(sheet("place_020"), "booking").value).toBe("Not in the data"); // not in the source
  });

  it("states the price level and that it comes from the data", () => {
    expect(fact(sheet("place_001"), "price").value).toBe("Level 2 of 4 in the data");
    const unpriced = { ...place("place_001"), priceLevel: null };
    expect(fact(stopFacts(unpriced, TUESDAY, { start: 600, end: 660 }), "price").value).toBe(
      "Not in the data",
    );
  });

  it("keeps the listing's description as its own text, and none when it is empty", () => {
    expect(sheet("place_001").description).toBe(place("place_001").description.trim());
    const bare = { ...place("place_001"), description: "   " };
    expect(stopFacts(bare, TUESDAY, { start: 600, end: 660 }).description).toBeNull();
  });

  it("writes its own sentences without dashes, leaving the listing's words as they are", () => {
    for (const item of places) {
      const result = stopFacts(item, TUESDAY, { start: 600, end: 660 });
      const ours = [
        ...result.facts.flatMap((entry) => [entry.label, entry.note ?? ""]),
        ...result.facts.filter((entry) => !entry.value.includes('"')).map((entry) => entry.value),
        ...result.unconfirmed.map((entry) => entry.text),
      ];
      for (const text of ours) expect(text, item.id).not.toMatch(/[—–]/);
    }
  });
});

describe("placeFacts: a place without a date", () => {
  const facts = (id: string | Place) => placeFacts(typeof id === "string" ? place(id) : id);
  const keys = (result: StopFactSheet) => result.facts.map((entry) => entry.key);

  it("gives the typical visit, the week's hours, booking, price and rating, in that order", () => {
    const colosseum = facts("place_001");
    expect(keys(colosseum)).toEqual(["visit", "hours", "booking", "price", "rating"]);
    expect(fact(colosseum, "visit")).toMatchObject({ label: "Typical visit", value: "2 h" });
    expect(fact(colosseum, "hours").week).toEqual([{ days: "Every day", hours: "09:00 to 19:00" }]);
    expect(fact(colosseum, "rating").value).toBe("4.8 of 5 in the data");
    expect(colosseum.description).toBe(place("place_001").description.trim());
  });

  it("runs days with the same hours together from Monday, and names the closed ones", () => {
    expect(fact(facts("place_003"), "hours").week).toEqual([
      { days: "Mon to Sat", hours: "12:30 to 14:30 and 19:30 to 22:30" },
      { days: "Sun", hours: null },
    ]);
    expect(fact(facts("place_059"), "hours").week).toEqual([
      { days: "Mon to Fri", hours: null },
      { days: "Sat and Sun", hours: "09:00 to 19:00" },
    ]);
    expect(fact(facts("place_059"), "dates").value).toBe(
      "Third Saturday and Sunday of the month only",
    );
  });

  it("says when hours are estimated, missing, or not set at all", () => {
    const rasputin = fact(facts("place_037"), "hours");
    expect(rasputin.note).toBe("Estimated, not listed.");
    expect(rasputin.week).toEqual([{ days: "Every day", hours: "18:00 to 24:00" }]);
    expect(fact(facts("place_021"), "hours")).toMatchObject({ value: "Not in the data" });
    expect(fact(facts("place_018"), "hours")).toMatchObject({ value: "No set hours" });
    expect(facts("place_018").unconfirmed.map((entry) => entry.key)).toContain("hours");
  });

  it("states booking only when the listing does, and a rating the data lacks", () => {
    expect(keys(facts("place_020"))).not.toContain("booking");
    const unrated = { ...place("place_001"), rating: null };
    expect(fact(facts(unrated), "rating")).toMatchObject({
      value: "Not in the data",
      numeric: false,
    });
    const bare = { ...place("place_001"), description: " " };
    expect(facts(bare).description).toBeNull();
  });
});

describe("weekRows", () => {
  it("reads a week with two matching days apart and a closed week as closed", () => {
    const open = [{ open: 540, close: 1080 }];
    expect(weekRows({ 0: [], 1: open, 2: [], 3: open, 4: open, 5: open, 6: open })).toEqual([
      { days: "Mon", hours: "09:00 to 18:00" },
      { days: "Tue", hours: null },
      { days: "Wed to Sat", hours: "09:00 to 18:00" },
      { days: "Sun", hours: null },
    ]);
    expect(weekRows({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] })).toEqual([
      { days: "Every day", hours: null },
    ]);
  });
});
