import { describe, expect, it } from "vitest";
import { normalizeDuration, parseDurationText } from "../../src/normalize/duration";
import { normalizePrice } from "../../src/normalize/price";
import { normalizeRating } from "../../src/normalize/rating";
import { makeWeek, WEEKDAYS } from "../../src/time";

// Duration, price, and rating normalizers, table-driven with real values from docs/data-profile.md plus the
// variants a differently formatted dataset would bring. Each row states what it prevents.

const ctx = { placeId: "p" };
const kinds = (issues: { kind: string }[]) => issues.map((issue) => issue.kind);

describe("normalizeDuration", () => {
  const dinnerOnly = makeWeek(
    [2, 3, 4, 5, 6],
    [
      { open: 750, close: 840 },
      { open: 1200, close: 1320 },
    ],
  );

  it("clamps Osteria Francescana's 240 minutes to 180, then to its 120-minute dinner service", () => {
    const { value, issues } = normalizeDuration(240, {
      placeId: "place_043",
      type: "restaurant",
      hours: dinnerOnly,
    });
    expect(value).toEqual({ durationMin: 120, durationSource: "clamped" });
    expect(kinds(issues)).toEqual(["duration_out_of_bounds", "duration_exceeds_hours"]);
  });

  it.each([
    ["viewpoint", 30],
    ["historic_site", 60],
    ["experience", 150],
  ] as const)(
    "uses the %s default when duration is null so every place has a visit length",
    (type, minutes) => {
      const { value, issues } = normalizeDuration(null, { placeId: "p", type, hours: null });
      expect(value).toEqual({ durationMin: minutes, durationSource: "type_default" });
      expect(kinds(issues)).toEqual(["duration_missing"]);
    },
  );

  it("keeps a listed duration inside bounds untouched", () => {
    const hours = makeWeek(WEEKDAYS, [{ open: 540, close: 750 }]);
    expect(normalizeDuration(210, { placeId: "p", type: "experience", hours })).toEqual({
      value: { durationMin: 210, durationSource: "listed" },
      issues: [],
    });
  });

  it.each([0, -30, Number.NaN, Number.POSITIVE_INFINITY, true, {}, "soon"])(
    "falls back to the type default for the unusable duration %j",
    (raw) => {
      const { value, issues } = normalizeDuration(raw, {
        placeId: "p",
        type: "museum",
        hours: null,
      });
      expect(value).toEqual({ durationMin: 120, durationSource: "type_default" });
      expect(kinds(issues)).toEqual(["duration_invalid"]);
    },
  );

  it.each([
    ["90", 90],
    ["90 min", 90],
    ["2h", 120],
    ["1.5 hours", 90],
    ["1-2 hours", 90],
    ["half day", 240],
    ["full day", 480],
  ])("reads the text duration %j as %i minutes", (text, minutes) => {
    expect(parseDurationText(text)).toBe(minutes);
    const { value, issues } = normalizeDuration(text, {
      placeId: "p",
      type: "experience",
      hours: null,
    });
    expect(value.durationMin).toBe(minutes);
    expect(kinds(issues)).toEqual(["duration_format"]);
  });

  it.each(["0 min", "2-1 hours", "a while", ""])("rejects the text duration %j", (text) => {
    expect(parseDurationText(text)).toBeNull();
  });
});

describe("normalizePrice", () => {
  it.each([
    ["€", 1],
    ["€€", 2],
    ["€€€", 3],
    ["€€€€", 4],
  ])("maps %s to level %i with no issue", (raw, level) => {
    expect(normalizePrice(raw, { ...ctx, tags: [] })).toEqual({ value: level, issues: [] });
  });

  it("keeps a free-tagged € viewpoint at level 1 and logs the conflict", () => {
    const { value, issues } = normalizePrice("€", { ...ctx, tags: ["views", "free"] });
    expect(value).toBe(1);
    expect(kinds(issues)).toEqual(["price_conflict"]);
  });

  it.each([
    ["$$", 2],
    [3, 3],
    ["4", 4],
    [0, 1],
    ["free", 1],
    ["Moderate", 2],
    ["luxury", 4],
  ])("converts the alternate price %j to level %i", (raw, level) => {
    const { value, issues } = normalizePrice(raw, { ...ctx, tags: [] });
    expect(value).toBe(level);
    expect(kinds(issues)).toEqual(["price_format"]);
  });

  it.each([null, undefined, "  "])(
    "treats a missing price (%j) as unknown so it passes budget filters",
    (raw) => {
      expect(normalizePrice(raw, { ...ctx, tags: [] }).value).toBeNull();
      expect(kinds(normalizePrice(raw, { ...ctx, tags: [] }).issues)).toEqual(["price_missing"]);
    },
  );

  it.each(["€€€€€", 5, 2.5, "pricey", {}, []])(
    "treats the unreadable price %j as unknown",
    (raw) => {
      const { value, issues } = normalizePrice(raw, { ...ctx, tags: [] });
      expect(value).toBeNull();
      expect(kinds(issues)).toEqual(["price_unparsed"]);
    },
  );
});

describe("price tags that contradict the listed price", () => {
  it.each([
    ["€€€", "budget", true],
    ["€€€€", "budget", true],
    ["€€", "splurge", true],
    ["€", "splurge", true],
    ["€€", "budget", false],
    ["€€€", "splurge", false],
  ])("logs %s tagged %s as a conflict: %s, and keeps the listed level", (raw, tag, conflict) => {
    const { value, issues } = normalizePrice(raw, { ...ctx, tags: [tag] });
    expect(value).toBe(raw.length);
    expect(kinds(issues)).toEqual(conflict ? ["price_conflict"] : []);
  });
});

describe("normalizeRating", () => {
  it("keeps Hard Rock Cafe's 2.1 but flags it so it is never suggested", () => {
    const { value, issues } = normalizeRating(2.1, ctx);
    expect(value).toBe(2.1);
    expect(kinds(issues)).toEqual(["low_rating"]);
  });

  it.each([3.5, 4.8, 5])("accepts the valid rating %s silently", (raw) => {
    expect(normalizeRating(raw, ctx)).toEqual({ value: raw, issues: [] });
  });

  it("keeps a zero rating as a real rating, flagged as low", () => {
    expect(normalizeRating(0, ctx)).toMatchObject({ value: 0, issues: [{ kind: "low_rating" }] });
  });

  it("halves a 10-point rating", () => {
    const { value, issues } = normalizeRating(8.7, ctx);
    expect(value).toBe(4.4);
    expect(kinds(issues)).toEqual(["rating_rescaled"]);
  });

  it.each([-1, 11, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats the out-of-range rating %s as unrated",
    (raw) => {
      const { value, issues } = normalizeRating(raw, ctx);
      expect(value).toBeNull();
      expect(kinds(issues)).toEqual(["rating_out_of_range"]);
    },
  );

  it("reads a numeric string and flags the format", () => {
    expect(normalizeRating("4.5", ctx)).toMatchObject({
      value: 4.5,
      issues: [{ kind: "rating_format" }],
    });
    expect(normalizeRating("great", ctx)).toMatchObject({
      value: null,
      issues: [{ kind: "rating_format" }],
    });
    expect(normalizeRating({}, ctx)).toMatchObject({
      value: null,
      issues: [{ kind: "rating_format" }],
    });
  });

  it("treats a missing rating as unrated", () => {
    expect(normalizeRating(null, ctx)).toMatchObject({
      value: null,
      issues: [{ kind: "rating_missing" }],
    });
  });
});
