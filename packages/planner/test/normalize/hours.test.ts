import { describe, expect, it } from "vitest";
import { FREE_TEXT_HOURS } from "../../src/config";
import { normalizeHours } from "../../src/normalize/hours";
import { parseWeeklyHours } from "../../src/normalize/hoursParser";
import { WEEKDAYS } from "../../src/time";
import type { TimeRange, WeeklyHours } from "../../src/types";
import { rawData } from "../helpers";

// A wrong "open" wastes a traveler's trip. These tests pin every hours string in the real data
// to an exact week, or to a documented policy, so a parser change cannot silently move a time.

const r = (open: string, close: string): TimeRange => {
  const toMin = (text: string) => Number(text.split(":")[0]) * 60 + Number(text.split(":")[1]);
  const o = toMin(open);
  const c = toMin(close);
  return { open: o, close: c < o ? c + 1440 : c };
};
/** A week from a 7-character pattern starting Sunday: "x" open with the ranges, "." closed. */
const week = (pattern: string, ...ranges: TimeRange[]): WeeklyHours => {
  const hours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } as WeeklyHours;
  for (const day of WEEKDAYS) if (pattern[day] === "x") hours[day] = ranges;
  return hours;
};

const listed = (text: string) => {
  const result = parseWeeklyHours(text);
  if (!result.ok) throw new Error(`${text}: ${result.reason}`);
  return result.hours;
};

describe("parseWeeklyHours on real strings", () => {
  it.each<[string, WeeklyHours]>([
    ["9:00-19:00", week("xxxxxxx", r("9:00", "19:00"))],
    ["8am-7pm", week("xxxxxxx", r("8:00", "19:00"))],
    ["9am-12:30pm", week("xxxxxxx", r("9:00", "12:30"))],
    ["7:30-24:00", week("xxxxxxx", r("7:30", "24:00"))],
    ["8:00-01:00", week("xxxxxxx", { open: 480, close: 1500 })],
    ["Daily 10:00-24:00", week("xxxxxxx", r("10:00", "24:00"))],
    ["Tues-Sun 9:00-19:00", week("x.xxxxx", r("9:00", "19:00"))],
    ["Mon-Sat 9:00-18:00", week(".xxxxxx", r("9:00", "18:00"))],
    ["Wed-Mon 10:00-18:00", week("xx.xxxx", r("10:00", "18:00"))],
    ["Sat-Sun 9:00-19:00", week("x.....x", r("9:00", "19:00"))],
    ["Wed-Sun 12:30-23:30", week("x..xxxx", r("12:30", "23:30"))],
    ["Tues, Thurs-Sun 10:00-18:00", week("x.x.xxx", r("10:00", "18:00"))],
    ["12:00-14:30, 19:00-22:30", week("xxxxxxx", r("12:00", "14:30"), r("19:00", "22:30"))],
    [
      "Tues-Sat 12:30-14:00, 20:00-22:00",
      week("..xxxxx", r("12:30", "14:00"), r("20:00", "22:00")),
    ],
    ["Mon-Sat 10:00-12:00, 14:30-18:00", week(".xxxxxx", r("10:00", "12:00"), r("14:30", "18:00"))],
  ])("parses %j into the exact week", (text, expected) => {
    expect(listed(text)).toEqual(expected);
  });

  it("gives Saturday its own longer hours in a multi-segment string", () => {
    const hours = listed("Mon-Fri 7:00-14:00, Sat 7:00-17:00");
    expect(hours[1]).toEqual([r("7:00", "14:00")]);
    expect(hours[5]).toEqual([r("7:00", "14:00")]);
    expect(hours[6]).toEqual([r("7:00", "17:00")]);
    expect(hours[0]).toEqual([]);
  });

  it("gives Sunday its short afternoon in 'Mon-Sat ..., Sun 14:00-17:30'", () => {
    const hours = listed("Mon-Sat 9:30-17:30, Sun 14:00-17:30");
    expect(hours[0]).toEqual([r("14:00", "17:30")]);
    expect(hours[3]).toEqual([r("9:30", "17:30")]);
  });

  it("parses or maps to a documented policy every distinct hours string in the data", () => {
    const strings = new Set<string>();
    for (const record of rawData()) if (typeof record.hours === "string") strings.add(record.hours);
    expect(strings.size).toBe(57);
    for (const text of strings) {
      const freeText = FREE_TEXT_HOURS.some((rule) => rule.pattern.test(text));
      const parsed = parseWeeklyHours(text);
      expect(freeText || parsed.ok, `unhandled hours string ${JSON.stringify(text)}`).toBe(true);
      if (!parsed.ok) continue;
      for (const day of WEEKDAYS) {
        for (const range of parsed.hours[day]) {
          expect(range.open).toBeGreaterThanOrEqual(0);
          expect(range.close).toBeGreaterThan(range.open);
          expect(range.close - range.open).toBeLessThanOrEqual(1440);
        }
      }
    }
  });
});

describe("parseWeeklyHours on formats not in the data yet", () => {
  it.each<[string, WeeklyHours]>([
    ["24h", week("xxxxxxx", r("0:00", "24:00"))],
    [`Tue${String.fromCharCode(0x2013)}Sun 10-18`, week("x.xxxxx", r("10:00", "18:00"))],
    ["09.00-19.00", week("xxxxxxx", r("9:00", "19:00"))],
    ["9:00-18:00, Mon closed", week("x.xxxxx", r("9:00", "18:00"))],
    ["Closed Mondays, 9:00-18:00", week("x.xxxxx", r("9:00", "18:00"))],
    [
      "Mon-Fri 9:00-12:00 and 14:00-18:00",
      week(".xxxxx.", r("9:00", "12:00"), r("14:00", "18:00")),
    ],
    ["9:00-13:00, 12:00-15:00", week("xxxxxxx", r("9:00", "15:00"))],
  ])("parses %j", (text, expected) => {
    expect(listed(text)).toEqual(expected);
  });

  it.each([
    "by appointment",
    "Closed",
    "Mon, Tue",
    "9:00-9:00",
    "25:00-26:00",
    "Mon closed",
    "Monkey 9-5",
    "9-",
    "open daily",
  ])("refuses %j instead of guessing", (text) => {
    expect(parseWeeklyHours(text).ok).toBe(false);
  });
});

describe("normalizeHours policy", () => {
  const context = { placeId: "p", type: "museum" as const, name: "Some Museum" };

  it("marks listed hours as listed and keeps the raw text", () => {
    const { value, issues } = normalizeHours("Tues-Sun 8:15-18:50", context);
    expect(value.confidence).toBe("listed");
    expect(value.hoursRaw).toBe("Tues-Sun 8:15-18:50");
    expect(value.hours?.[1]).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("logs a past-midnight close so the audit shows it", () => {
    const { value, issues } = normalizeHours("8:00-01:00", context);
    expect(value.hours?.[3]).toEqual([{ open: 480, close: 1500 }]);
    expect(issues.map((issue) => issue.kind)).toEqual(["hours_past_midnight"]);
  });

  it.each([
    ["Evenings", { open: 1080, close: 1440 }],
    ["Morning only", { open: 420, close: 780 }],
  ])("estimates %j as a derived window every day, never as unknown", (text, window) => {
    const { value, issues } = normalizeHours(text, context);
    expect(value.confidence).toBe("derived");
    expect(value.derivation).toEqual({ source: "free_text", match: text, window });
    for (const day of WEEKDAYS) expect(value.hours?.[day]).toEqual([window]);
    expect(issues[0]?.kind).toBe("hours_free_text");
  });

  it("never lets Trevi Fountain by Night open in the morning", () => {
    const { value } = normalizeHours(null, {
      placeId: "place_077",
      type: "viewpoint",
      name: "Trevi Fountain by Night",
    });
    expect(value.confidence).toBe("derived");
    expect(value.hours?.[2]).toEqual([{ open: 1200, close: 1440 }]);
  });

  it.each([
    ["Piazza del Popolo at Dawn", { open: 360, close: 600 }],
    ["Early Morning in Cannaregio", { open: 360, close: 660 }],
    ["Navigli Canals at Aperitivo Hour", { open: 1050, close: 1260 }],
    ["Piazza Maggiore at Night", { open: 1200, close: 1440 }],
  ])("reads the time of day from the name %j when hours are empty", (name, window) => {
    const { value, issues } = normalizeHours(null, { placeId: "p", type: "viewpoint", name });
    expect(value.derivation).toMatchObject({ source: "name_hint", window });
    expect(issues[0]?.kind).toBe("hours_name_hint");
  });

  it("lets listed hours win over a time of day in the name", () => {
    const { value } = normalizeHours("9:00-18:00", {
      placeId: "p",
      type: "cafe",
      name: "Coffee at Night",
    });
    expect(value.confidence).toBe("listed");
    expect(value.hours?.[0]).toEqual([{ open: 540, close: 1080 }]);
  });

  it.each(["viewpoint", "neighborhood", "park", "historic_site"] as const)(
    "treats an empty-hours %s as an open-access public space",
    (type) => {
      const { value, issues } = normalizeHours(null, { placeId: "p", type, name: "Piazza Navona" });
      expect(value.confidence).toBe("open_access");
      expect(value.hours?.[1]).toEqual([{ open: 420, close: 1380 }]);
      expect(issues[0]?.kind).toBe("hours_open_access");
    },
  );

  it.each(["experience", "museum", "restaurant", "other"] as const)(
    "keeps empty hours on a %s unknown, never open access",
    (type) => {
      const { value, issues } = normalizeHours(null, {
        placeId: "p",
        type,
        name: "Siena Day Trip",
      });
      expect(value).toEqual({
        hours: null,
        confidence: "unknown",
        hoursRaw: null,
        derivation: null,
        closed: false,
        dateRules: [],
      });
      expect(issues[0]?.kind).toBe("hours_missing");
    },
  );

  it.each([["by appointment"], [42], [{ open: "9" }], [["9-5"]], [true]])(
    "treats unreadable hours %j as unknown with an hours_unparsed issue",
    (raw) => {
      const { value, issues } = normalizeHours(raw, context);
      expect(value.hours).toBeNull();
      expect(value.confidence).toBe("unknown");
      expect(issues[0]?.kind).toBe("hours_unparsed");
    },
  );

  it("treats an empty string like missing hours", () => {
    expect(normalizeHours("   ", context).value.confidence).toBe("unknown");
    expect(normalizeHours("   ", context).issues[0]?.kind).toBe("hours_missing");
  });
});
