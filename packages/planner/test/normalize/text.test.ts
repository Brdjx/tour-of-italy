import { describe, expect, it } from "vitest";
import { rawText } from "../../src/normalize/issue";
import {
  normalizeBooking,
  normalizeCity,
  normalizeName,
  normalizeRegion,
} from "../../src/normalize/names";
import { normalizeType } from "../../src/normalize/placeType";
import { normalizePrice } from "../../src/normalize/price";
import { canonicalTag, normalizeTags, tagLabel } from "../../src/normalize/tags";

// Text normalizers (names, cities, regions, booking, types, tags), table-driven with real values from docs/data-profile.md plus the
// variants a differently formatted dataset would bring. Each row states what it prevents.

const ctx = { placeId: "p" };
const kinds = (issues: { kind: string }[]) => issues.map((issue) => issue.kind);

describe("names, cities, regions, booking", () => {
  it.each([
    ["Roma", "Rome"],
    ["FIRENZE", "Florence"],
    ["  venezia ", "Venice"],
    ["Padova", "Padua"],
    ["SORRENTO", "Sorrento"],
  ])("maps the city %j to %j so bases group correctly", (raw, city) => {
    const { value, issues } = normalizeCity(raw, ctx);
    expect(value).toBe(city);
    expect(kinds(issues)).toEqual(["city_variant"]);
  });

  it("keeps a canonical city and region without issues", () => {
    expect(normalizeCity("Isola della Scala", ctx)).toEqual({
      value: "Isola della Scala",
      issues: [],
    });
    expect(normalizeRegion("Emilia-Romagna", ctx)).toEqual({ value: "Emilia-Romagna", issues: [] });
  });

  it("maps Italian region names to English", () => {
    expect(normalizeRegion("Lombardia", ctx).value).toBe("Lombardy");
    expect(normalizeRegion("emilia romagna", ctx).value).toBe("Emilia-Romagna");
  });

  it("cleans whitespace and control characters out of a name", () => {
    const { value, issues } = normalizeName(`  Pantheon${String.fromCharCode(7)}  `, ctx);
    expect(value).toBe("Pantheon");
    expect(kinds(issues)).toEqual(["name_variant"]);
  });

  it.each([null, "", "   ", 42])("excludes a record with no usable name (%j)", (raw) => {
    expect(normalizeName(raw, ctx)).toMatchObject({
      value: null,
      issues: [{ kind: "name_missing" }],
    });
  });

  it("keeps booking null when the source does not say, and flags a non-boolean", () => {
    expect(normalizeBooking(null, ctx)).toMatchObject({
      value: null,
      issues: [{ kind: "booking_missing" }],
    });
    expect(normalizeBooking("yes", ctx)).toMatchObject({
      value: null,
      issues: [{ kind: "booking_invalid" }],
    });
    expect(normalizeBooking(true, ctx)).toEqual({ value: true, issues: [] });
  });
});

describe("normalizeType", () => {
  it.each([
    "historic_site",
    "restaurant",
    "experience",
    "museum",
    "viewpoint",
    "cafe",
    "neighborhood",
    "market",
    "park",
    "shop",
  ])("passes the real type %s through untouched", (type) => {
    expect(normalizeType(type, ctx)).toEqual({ value: type, issues: [] });
  });

  it.each([
    ["Historic Site", "historic_site"],
    ["trattoria", "restaurant"],
    ["Gelateria", "cafe"],
    ["wine bar", "cafe"],
    ["Basilica", "historic_site"],
  ])("maps the variant %j to %s", (raw, type) => {
    expect(normalizeType(raw, ctx)).toMatchObject({
      value: type,
      issues: [{ kind: "type_variant" }],
    });
  });

  it.each(["vineyard", "coastal_town", null, "other", 7])(
    "maps the unknown type %j to other",
    (raw) => {
      expect(normalizeType(raw, ctx)).toMatchObject({
        value: "other",
        issues: [{ kind: "type_unknown" }],
      });
    },
  );
});

describe("normalizeTags", () => {
  it("rewrites local_favorite as local-favorite so interest chips merge", () => {
    const { value, issues } = normalizeTags(["local_favorite", "evening", "food"], ctx);
    expect(value).toEqual(["local-favorite", "evening", "food"]);
    expect(kinds(issues)).toEqual(["tag_variant"]);
  });

  it("drops repeats, empty tags, and non-text tags with issues", () => {
    const { value, issues } = normalizeTags(["Food", "food", "", 3, null, "Local Favourite"], ctx);
    expect(value).toEqual(["food", "local-favorite"]);
    expect(kinds(issues)).toEqual([
      "tag_variant",
      "tag_variant",
      "tag_invalid",
      "tag_invalid",
      "tag_invalid",
      "tag_variant",
    ]);
  });

  it.each([null, "food, wine", { food: true }])(
    "uses no tags when tags are not a list (%j)",
    (raw) => {
      expect(normalizeTags(raw, ctx)).toMatchObject({
        value: [],
        issues: [{ kind: "tags_missing" }],
      });
    },
  );

  it("labels tags in sentence case", () => {
    expect(tagLabel("local-favorite")).toBe("Local favorite");
    expect(tagLabel("rainy-day")).toBe("Rainy day");
    expect(canonicalTag("  Hidden Gem ")).toBe("hidden-gem");
  });
});

describe("inherited object keys in the data", () => {
  // Found by the fuzz tests: a plain-object table lookup with "__proto__" returned Object's
  // prototype as a price level. Every table lookup now ignores inherited members.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "treats %j as ordinary text in every lookup table",
    (key) => {
      expect(normalizePrice(key, { ...ctx, tags: [] }).value).toBeNull();
      expect(normalizeCity(key, ctx).value?.toLowerCase()).toBe(key.toLowerCase());
      expect(normalizeRegion(key, ctx).value?.toLowerCase()).toBe(key.toLowerCase());
      expect(normalizeType(key, ctx).value).toBe("other");
      expect(normalizeTags([key], ctx).value).toEqual([canonicalTag(key)]);
      expect(typeof normalizeTags([key], ctx).value[0]).toBe("string");
    },
  );
});

describe("rawText", () => {
  it("never throws on values JSON cannot represent", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hostile: Record<string, unknown> = {
      toString() {
        throw new Error("no");
      },
    };
    hostile.self = hostile;
    expect(rawText(BigInt(7))).toBe("7");
    expect(rawText(cycle)).toBe("[object Object]");
    expect(rawText(hostile)).toBe("[object Object]");
    expect(rawText(undefined)).toBeNull();
  });

  it("cuts long raw values so issue logs stay small", () => {
    expect(rawText("x".repeat(500))?.length).toBe(120);
  });
});
