import { describe, expect, it } from "vitest";
import { normalizeHours } from "../../src/normalize/hours";
import { parseWeeklyHours } from "../../src/normalize/hoursParser";
import { normalizePlaces } from "../../src/normalize/index";
import { hoursOn } from "../../src/time";
import { rawRecord, withExtraRecords } from "../helpers";

// Hours text that could make the planner send a traveler to a closed door: a close before the
// open read as a 20-hour day, a "closed" listing kept as unknown (and so schedulable), or a
// ticketed church typed by an alias treated as an always-open square.

const context = { placeId: "p", type: "museum" as const, name: "Some Museum" };

describe("closing times before the opening time", () => {
  it.each(["9-5", "9:00-5:00", "10-6", "19:00-7:00", "12:00-5:00", "8:00-1:00"])(
    "refuses the ambiguous %j instead of reading a day that runs past midnight",
    (text) => {
      const parsed = parseWeeklyHours(text);
      expect(parsed.ok).toBe(false);
      const { value, issues } = normalizeHours(text, context);
      expect(value.hours).toBeNull();
      expect(issues.map((issue) => issue.kind)).toEqual(["hours_unparsed"]);
    },
  );

  it.each([
    ["8:00-01:00", 480, 1500],
    ["19:00-02:00", 1140, 1560],
    ["22:00-2:00", 1320, 1560],
    ["9pm-2am", 1260, 1560],
    ["18:00-00:00", 1080, 1440],
  ])("still reads the unambiguous late close %j as after midnight", (text, open, close) => {
    const parsed = parseWeeklyHours(text);
    expect(parsed.ok && parsed.hours[3]).toEqual([{ open, close }]);
  });
});

describe("hours text that says the place is shut", () => {
  it.each([
    "Closed",
    "Temporarily closed",
    "Permanently closed",
    "Mon-Sun closed",
    "Daily closed",
    "Closed until further notice",
    "Closed for restoration",
  ])("excludes a record whose hours say %j instead of planning it with unknown hours", (text) => {
    const result = withExtraRecords(rawRecord({ hours: text }));
    expect(result.places.find((p) => p.id === "place_900")).toBeUndefined();
    expect(result.excluded).toEqual([
      expect.objectContaining({ id: "place_900", reason: "closed" }),
    ]);
    expect(
      result.issues.filter((issue) => issue.placeId === "place_900").map((i) => i.kind),
    ).toContain("place_closed");
  });

  it("excludes a record whose seasonal note says it is temporarily closed", () => {
    const result = normalizePlaces([rawRecord({ seasonal_notes: "Temporarily closed." })]);
    expect(result.places).toEqual([]);
    expect(result.excluded.map((record) => record.reason)).toEqual(["closed"]);
  });

  it("keeps the Monday closure from hours that list only 'Closed Mondays'", () => {
    const { value, issues } = normalizeHours("Closed Mondays", context);
    expect(value.hours).toBeNull();
    expect(value.closed).toBe(false);
    expect(value.dateRules).toEqual([
      { kind: "weekdays", days: [0, 2, 3, 4, 5, 6], source: "Closed Mondays" },
    ]);
    expect(issues[0]?.action).toContain("closed every Mon");
    const place = { hours: value.hours, dateRules: value.dateRules };
    expect(hoursOn(place, "2026-10-05")).toEqual([]); // a Monday
    expect(hoursOn(place, "2026-10-06")).toBe("unknown");
  });
});

describe("open access follows the raw type, not the alias it maps to", () => {
  it.each(["church", "basilica", "cathedral", "monument", "landmark", "ruins", "garden"])(
    "keeps a %j with no hours unknown instead of open 07:00 to 23:00",
    (type) => {
      const result = withExtraRecords(rawRecord({ type, hours: null }));
      const place = result.places.find((p) => p.id === "place_900");
      expect(place?.hoursConfidence).toBe("unknown");
      expect(place?.hours).toBeNull();
    },
  );

  it.each(["square", "piazza", "viewpoint", "Historic Site", "park"])(
    "treats a %j with no hours as an open-access public space",
    (type) => {
      const result = withExtraRecords(rawRecord({ type, hours: null, name: "Some Square" }));
      expect(result.places.find((p) => p.id === "place_900")?.hoursConfidence).toBe("open_access");
    },
  );
});
