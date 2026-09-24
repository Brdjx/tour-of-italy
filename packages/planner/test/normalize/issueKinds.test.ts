import { describe, expect, it } from "vitest";
import { PlaceSchema } from "../../src/dataSchemas";
import { ISSUE_KINDS } from "../../src/enums";
import { normalizePlaces } from "../../src/normalize/index";
import type { IssueKind, NormalizeResult } from "../../src/types";
import { rawData, rawRecord, withExtraRecords } from "../helpers";

// One test per issue class. Each row feeds normalizePlaces the real data plus one corrupted
// record and checks that the issue is logged against the right id and that the record ends up
// either as a valid place or as a logged exclusion. The last test fails if a new issue kind is
// added without a row here.

interface Case {
  input: () => NormalizeResult; // the dataset to normalize
  id: string; // the place or record the issue must name
  excluded?: boolean; // the record must be excluded rather than kept
}

const extra = (overrides: Record<string, unknown>) => () => withExtraRecords(rawRecord(overrides));

const CASES: Record<IssueKind, Case> = {
  dataset_shape: { input: () => normalizePlaces({ places: rawData() }), id: "dataset" },
  record_invalid: { input: () => withExtraRecords(42), id: "record_104", excluded: true },
  id_missing: { input: extra({ id: null, name: "Night Tour" }), id: "rome-night-tour" },
  id_duplicate: { input: extra({ id: "place_001", name: "Another Place" }), id: "place_001-2" },
  duplicate_place: { input: extra({ name: "Colosseum" }), id: "place_900", excluded: true },
  name_missing: { input: extra({ name: "   " }), id: "place_900", excluded: true },
  name_variant: { input: extra({ name: " Test   Place " }), id: "place_900" },
  city_missing: { input: extra({ city: null }), id: "place_900" },
  city_variant: { input: extra({ city: "Roma" }), id: "place_900" },
  region_missing: { input: extra({ region: null }), id: "place_900" },
  region_variant: { input: extra({ region: "lazio" }), id: "place_900" },
  neighborhood_missing: { input: extra({ neighborhood: null }), id: "place_900" },
  neighborhood_corrected: { input: () => normalizePlaces(rawData()), id: "place_026" },
  description_missing: { input: extra({ description: 7 }), id: "place_900" },
  type_variant: { input: extra({ type: "Museum" }), id: "place_900" },
  type_unknown: { input: extra({ type: "vineyard" }), id: "place_900" },
  tags_missing: { input: extra({ tags: "food" }), id: "place_900" },
  tag_variant: { input: extra({ tags: ["Food"] }), id: "place_900" },
  tag_invalid: { input: extra({ tags: [""] }), id: "place_900" },
  hours_missing: { input: extra({ hours: null, type: "experience" }), id: "place_900" },
  hours_open_access: { input: extra({ hours: null, type: "park" }), id: "place_900" },
  hours_free_text: { input: extra({ hours: "Evenings" }), id: "place_900" },
  hours_name_hint: { input: extra({ hours: null, name: "Forum by Night" }), id: "place_900" },
  hours_unparsed: { input: extra({ hours: "by appointment" }), id: "place_900" },
  hours_past_midnight: { input: extra({ hours: "19:00-02:00" }), id: "place_900" },
  hours_conflict: { input: extra({ seasonal_notes: "Closed Mondays." }), id: "place_900" },
  place_closed: { input: extra({ hours: "Temporarily closed" }), id: "place_900", excluded: true },
  season_restriction: {
    input: extra({ seasonal_notes: "Open April-October only." }),
    id: "place_900",
  },
  date_restriction: {
    input: extra({ hours: null, type: "experience", seasonal_notes: "Weekdays only." }),
    id: "place_900",
  },
  note_not_applied: {
    input: extra({ seasonal_notes: "Summer hours extend to 21:00." }),
    id: "place_900",
  },
  note_info: { input: extra({ seasonal_notes: "Best in spring." }), id: "place_900" },
  note_unread: {
    input: extra({ seasonal_notes: "Closed on public holidays." }),
    id: "place_900",
  },
  booking_missing: { input: extra({ booking_required: null }), id: "place_900" },
  booking_invalid: { input: extra({ booking_required: "yes" }), id: "place_900" },
  duration_missing: { input: extra({ duration_minutes: null }), id: "place_900" },
  duration_invalid: { input: extra({ duration_minutes: -5 }), id: "place_900" },
  duration_format: { input: extra({ duration_minutes: "2 hours" }), id: "place_900" },
  duration_out_of_bounds: { input: extra({ duration_minutes: 600 }), id: "place_900" },
  duration_exceeds_hours: {
    input: extra({ hours: "10:00-11:00", duration_minutes: 120 }),
    id: "place_900",
  },
  meal_unavailable: {
    input: extra({ type: "restaurant", hours: "19:30-22:30", duration_minutes: 90 }),
    id: "place_900",
  },
  price_missing: { input: extra({ price_range: null }), id: "place_900" },
  price_format: { input: extra({ price_range: "$$" }), id: "place_900" },
  price_unparsed: { input: extra({ price_range: "pricey" }), id: "place_900" },
  price_conflict: { input: extra({ tags: ["free"], price_range: "€" }), id: "place_900" },
  rating_missing: { input: extra({ rating: null }), id: "place_900" },
  rating_format: { input: extra({ rating: "4.5" }), id: "place_900" },
  rating_rescaled: { input: extra({ rating: 9 }), id: "place_900" },
  rating_out_of_range: { input: extra({ rating: 42 }), id: "place_900" },
  low_rating: { input: extra({ rating: 2 }), id: "place_900" },
  coords_missing: { input: extra({ latitude: null }), id: "place_900" },
  coords_format: { input: extra({ latitude: "41.8951", longitude: "12.4801" }), id: "place_900" },
  coords_swapped: { input: extra({ latitude: 12.4801, longitude: 41.8951 }), id: "place_900" },
  coords_out_of_bounds: { input: extra({ latitude: 48.85, longitude: 2.35 }), id: "place_900" },
  coords_far_from_city: { input: extra({ latitude: 41.5, longitude: 13.5 }), id: "place_900" },
  coords_unrepairable: {
    input: extra({ city: "Atlantis", latitude: null }),
    id: "place_900",
    excluded: true,
  },
  shared_location: { input: extra({ latitude: 41.8902, longitude: 12.4922 }), id: "place_900" },
  same_experience: { input: () => normalizePlaces(rawData()), id: "place_044" },
};

describe("every issue class is logged, and the record is kept or excluded, never lost", () => {
  it.each(Object.entries(CASES))("logs %s against the right record", (kind, testCase) => {
    const result = testCase.input();
    const issue = result.issues.find(
      (candidate) => candidate.kind === kind && candidate.placeId === testCase.id,
    );
    expect(issue, `${kind} for ${testCase.id}`).toBeDefined();
    expect(issue?.action.length).toBeGreaterThan(0);
    if (testCase.id === "dataset") return;
    const kept = result.places.find((p) => p.id === testCase.id);
    const dropped = result.excluded.find((record) => record.id === testCase.id);
    if (testCase.excluded) {
      expect(dropped, `${testCase.id} should be excluded`).toBeDefined();
      expect(kept).toBeUndefined();
    } else {
      expect(kept, `${testCase.id} should be kept`).toBeDefined();
      expect(PlaceSchema.safeParse(kept).success).toBe(true);
    }
  });

  it("has a case for every issue kind, so a new kind cannot ship untested", () => {
    expect(Object.keys(CASES).sort()).toEqual([...ISSUE_KINDS].sort());
  });
});

describe("what each fix does", () => {
  const onlyExtra = (overrides: Record<string, unknown>) =>
    extra(overrides)().places.find((p) => p.id === "place_900");

  it("infers a missing city from the nearest place", () => {
    expect(onlyExtra({ city: null })?.city).toBe("Rome");
  });

  it("fills a missing region from the city's other places", () => {
    expect(onlyExtra({ region: null })?.region).toBe("Lazio");
  });

  it("repairs a missing point to the neighborhood centroid and marks it approximate", () => {
    const repaired = onlyExtra({ latitude: null });
    expect(repaired?.locationSource).toBe("neighborhood_centroid");
    expect(repaired?.lat).toBeCloseTo(41.8902, 2);
  });

  it("repairs a far point to the city centroid when the neighborhood has no siblings", () => {
    const repaired = onlyExtra({ latitude: 41.5, longitude: 13.5, neighborhood: "Nowhere" });
    expect(repaired?.locationSource).toBe("city_centroid");
    expect(repaired?.lng).toBeLessThan(12.6);
  });

  it("keeps the more complete duplicate and merges the tags", () => {
    const result = extra({ name: "Colosseum", tags: ["gladiators"] })();
    const colosseum = result.places.find((p) => p.id === "place_001");
    expect(colosseum?.tags).toContain("gladiators");
    expect(result.places).toHaveLength(103);
  });

  it("keeps the listed point when a city's places disagree and none can be trusted", () => {
    // Four corners of a 2-degree square: each point's "other places" median is the far corner.
    const spread = [
      [41.0, 12.0],
      [41.0, 14.0],
      [43.0, 12.0],
      [43.0, 14.0],
    ].map(([latitude, longitude], index) =>
      rawRecord({
        id: `spread_${index}`,
        name: `Spread ${index}`,
        city: "Testville",
        latitude,
        longitude,
      }),
    );
    const result = normalizePlaces(spread);
    expect(result.places).toHaveLength(4);
    for (const p of result.places) expect(p.locationSource).toBe("listed");
    const far = result.issues.filter((issue) => issue.kind === "coords_far_from_city");
    expect(far.length).toBeGreaterThan(0);
    expect(far.every((issue) => issue.action.startsWith("Kept"))).toBe(true);
  });
});
