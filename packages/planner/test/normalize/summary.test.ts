import { describe, expect, it } from "vitest";
import { FREE_TEXT_HOURS, MIN_SUGGEST_RATING, OPEN_ACCESS_WINDOW } from "../../src/config";
import { buildDataset } from "../../src/data";
import { ISSUE_KINDS } from "../../src/enums";
import { dateRuleNotes, placeNotes } from "../../src/normalize/chips";
import { ISSUE_KIND_TEXT } from "../../src/normalize/issueText";
import { buildDataSummary } from "../../src/normalize/summary";
import { formatClock } from "../../src/time";
import { place, rawData, rawRecord, realResult } from "../helpers";

// The "About this data" panel and the per-place chips are how the traveler learns which facts
// are estimated. Wrong or missing notes would present a guess as a fact.

const EM_DASH = String.fromCharCode(0x2014);

describe("buildDataSummary", () => {
  const summary = buildDataSummary(realResult());

  it("reports 103 records, all schedulable, in one plain sentence", () => {
    expect(summary.totals).toMatchObject({ records: 103, schedulable: 103, excluded: 0 });
    expect(summary.headline).toBe("103 places loaded, all usable for planning.");
  });

  it("lists each issue kind once, counting distinct places", () => {
    const hoursMissing = summary.items.find((item) => item.kind === "hours_missing");
    expect(hoursMissing?.count).toBe(11);
    expect(hoursMissing?.places.map((p) => p.id)).toContain("place_021");
    expect(new Set(summary.items.map((item) => item.kind)).size).toBe(summary.items.length);
  });

  it("puts traveler-facing hours notes before bookkeeping such as tag spelling", () => {
    const order = summary.items.map((item) => item.kind);
    expect(order.indexOf("hours_missing")).toBeLessThan(order.indexOf("tag_variant"));
  });

  it("names the Brera market under Approximate location", () => {
    const approximate = summary.items.find((item) => item.kind === "coords_far_from_city");
    expect(approximate?.places).toEqual([{ id: "place_059", name: "Brera Antique Market" }]);
  });

  it("has plain-language text for every issue kind, with no em dashes", () => {
    for (const kind of ISSUE_KINDS) {
      const text = ISSUE_KIND_TEXT[kind];
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.explanation.length).toBeGreaterThan(0);
      expect(`${text.title}${text.explanation}`).not.toContain(EM_DASH);
    }
  });

  it("says how many were left out when some records are excluded", () => {
    const dataset = buildDataset([...rawData(), 7, { name: "" }]);
    expect(dataset.summary.headline).toBe(
      "105 places loaded, 103 usable for planning and 2 left out.",
    );
    expect(dataset.byId.size).toBe(103);
  });
});

describe("placeNotes chips", () => {
  const labels = (id: string) => placeNotes(place(id)).map((note) => note.label);

  it("tells the traveler an experience's hours are not confirmed", () => {
    expect(labels("place_021")).toContain("Hours not confirmed");
  });

  it("marks derived and open-access hours differently", () => {
    expect(labels("place_077")).toContain("Hours estimated from the listing");
    expect(labels("place_008")).toContain("Public space, no set hours");
  });

  it("shows the season, the third Saturday and Sunday, and the approximate location", () => {
    expect(labels("place_035")).toContain("Open Apr to Oct");
    expect(labels("place_090")).toContain("Open Oct only");
    // "Third weekend" would be wrong when the 1st is a Sunday: the 15th and 21st are not adjacent.
    expect(labels("place_059")).toEqual(
      expect.arrayContaining([
        "Third Saturday and Sunday of the month only",
        "Hours conflict in source, using the stricter one",
        "Approximate location",
      ]),
    );
    expect(labels("place_059")).not.toContain("Sat and Sun only");
  });

  it("shows weekday-only, estimated visit time, and Book ahead", () => {
    expect(labels("place_053")).toContain("Mon to Fri only");
    expect(labels("place_014")).toContain("Estimated visit time");
    expect(labels("place_001")).toContain("Book ahead");
  });

  it("gives a fully listed place no data chips beyond booking", () => {
    expect(labels("place_005")).toEqual([]);
  });

  it("labels a weekly closure and an arbitrary day window", () => {
    expect(
      dateRuleNotes([{ kind: "weekdays", days: [0, 2, 3, 4, 5, 6], source: "Closed Mondays" }]),
    ).toEqual([{ kind: "date_rule", label: "Closed Mon" }]);
    expect(dateRuleNotes([{ kind: "day_of_month", from: 3, to: 9, source: "x" }])[0]?.label).toBe(
      "Open days 3 to 9 of the month only",
    );
    expect(dateRuleNotes([{ kind: "weekdays", days: [1, 3], source: "y" }])[0]?.label).toBe(
      "Mon, Wed only",
    );
  });

  it("names the exact days for ordinal rules instead of a vague 'weekend'", () => {
    const labelsFor = (text: string) =>
      dateRuleNotes(
        buildDataset([rawRecord({ seasonal_notes: text })]).places[0]?.dateRules ?? [],
      ).map((note) => note.label);
    expect(labelsFor("Last weekend of each month only.")).toEqual([
      "Last Saturday and Sunday of the month only",
    ]);
    expect(labelsFor("Third Sunday of each month only.")).toEqual([
      "Third Sunday of the month only",
    ]);
    expect(labelsFor("Closed Mondays and Tuesdays.")).toEqual(["Closed Mon and Tue"]);
  });
});

describe("About this data wording follows config", () => {
  const configClocks = new Set(
    [OPEN_ACCESS_WINDOW, ...FREE_TEXT_HOURS.map((rule) => rule.window)].flatMap((window) => [
      formatClock(window.open),
      formatClock(window.close),
    ]),
  );

  it("states the open-access window, the estimated windows, and the rating floor from config", () => {
    const text = ISSUE_KIND_TEXT;
    const span = `${formatClock(OPEN_ACCESS_WINDOW.open)} to ${formatClock(OPEN_ACCESS_WINDOW.close)}`;
    expect(text.hours_open_access.explanation).toContain(span);
    for (const rule of FREE_TEXT_HOURS) {
      const window = `${formatClock(rule.window.open)} to ${formatClock(rule.window.close)}`;
      expect(text.hours_free_text.explanation).toContain(window);
    }
    expect(text.low_rating.explanation).toContain(`below ${MIN_SUGGEST_RATING}`);
  });

  it("never hard-codes a clock time that config does not define", () => {
    for (const [kind, entry] of Object.entries(ISSUE_KIND_TEXT)) {
      for (const clock of entry.explanation.match(/\d{2}:\d{2}/g) ?? []) {
        expect(configClocks.has(clock), `${kind}: ${clock}`).toBe(true);
      }
    }
  });
});
