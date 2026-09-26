import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXTRA_MEAL_PLACES, TYPE_DURATIONS } from "../../src/config";
import { PlaceSchema } from "../../src/dataSchemas";
import { haversineKm, insideItaly } from "../../src/normalize/geo";
import { longestOpenRange } from "../../src/time";
import { place, readDataBytes, realResult } from "../helpers";

// Invariants over the real dataset. If any of these break, the planner could schedule a place at
// an impossible spot, time, or length. Specific records pin the policies in docs/data-issues.md.

const DATASET_SHA256 = "e81d04d73dcd793ec18795bdc0f47672a946f93d7170badcfaa8e1f2b715938a";

describe("data/italy.json", () => {
  it("has not been edited: its checksum matches the recorded one", () => {
    expect(createHash("sha256").update(readDataBytes()).digest("hex")).toBe(DATASET_SHA256);
  });
});

describe("normalizePlaces over the real data", () => {
  const { places, excluded, issues } = realResult();

  it("keeps all 103 records schedulable and excludes none", () => {
    expect(places).toHaveLength(103);
    expect(excluded).toEqual([]);
  });

  it("gives every place a unique, non-empty id", () => {
    const ids = places.map((p) => p.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts every place at finite coordinates inside Italy", () => {
    for (const p of places) {
      expect(Number.isFinite(p.lat) && Number.isFinite(p.lng), p.id).toBe(true);
      expect(insideItaly(p), p.id).toBe(true);
    }
  });

  it("keeps every visit length within its type bounds and inside one open range", () => {
    for (const p of places) {
      const bounds = TYPE_DURATIONS[p.type];
      const longest = p.hours ? longestOpenRange(p.hours) : Number.POSITIVE_INFINITY;
      expect(p.durationMin, p.id).toBeGreaterThanOrEqual(Math.min(bounds.min, longest));
      expect(p.durationMin, p.id).toBeLessThanOrEqual(Math.min(bounds.max, longest));
    }
  });

  it("keeps every rating null or between 0 and 5", () => {
    for (const p of places)
      if (p.rating !== null) expect(p.rating >= 0 && p.rating <= 5, p.id).toBe(true);
  });

  it("ties every issue to an existing place or excluded record", () => {
    const known = new Set([...places.map((p) => p.id), ...excluded.map((record) => record.id)]);
    for (const issue of issues) expect(known.has(issue.placeId), issue.placeId).toBe(true);
  });

  it("produces places that match the shared Place schema the web app parses with", () => {
    for (const p of places) expect(PlaceSchema.safeParse(p).success, p.id).toBe(true);
  });

  it("repeats each place's issues in the full issue list", () => {
    const perPlace = places.reduce((count, p) => count + p.issues.length, 0);
    expect(perPlace).toBe(issues.length);
  });
});

describe("policies pinned to real records", () => {
  it("moves the Brera Antique Market back to Brera, within 2 km of Pinacoteca di Brera", () => {
    const brera = place("place_059");
    expect(brera.locationSource).toBe("neighborhood_centroid");
    expect(haversineKm(brera, place("place_058"))).toBeLessThan(2);
    expect(brera.issues.map((issue) => issue.kind)).toContain("coords_far_from_city");
  });

  it("clamps Osteria Francescana to its longest service so the whole meal fits", () => {
    const francescana = place("place_043");
    expect(francescana.durationMin).toBe(120);
    expect(francescana.durationSource).toBe("clamped");
  });

  it("gives Trevi Fountain by Night a 20:00 to 24:00 window and links it to the daytime fountain", () => {
    const night = place("place_077");
    expect(night.hoursConfidence).toBe("derived");
    expect(night.hours?.[3]).toEqual([{ open: 1200, close: 1440 }]);
    expect(night.sharedLocationWith).toEqual(["place_018"]);
    expect(place("place_018").sharedLocationWith).toEqual(["place_077"]);
  });

  it("links the two Mercato Centrale listings as one location", () => {
    expect(place("place_030").sharedLocationWith).toEqual(["place_031"]);
    expect(place("place_031").sharedLocationWith).toEqual(["place_030"]);
  });

  it("keeps Hard Rock Cafe Rome with its 2.1 rating and a low_rating issue", () => {
    const hardRock = place("place_025");
    expect(hardRock.rating).toBe(2.1);
    expect(hardRock.issues.map((issue) => issue.kind)).toContain("low_rating");
  });

  it("treats the six null-hours historic sites as open-access public spaces", () => {
    const sites = realResult().places.filter(
      (p) => p.type === "historic_site" && p.hoursRaw === null,
    );
    expect(sites.map((p) => p.id)).toEqual([
      "place_008",
      "place_018",
      "place_019",
      "place_060",
      "place_066",
      "place_084",
    ]);
    for (const site of sites) expect(site.hoursConfidence).toBe("open_access");
  });

  it("splits the 33 null-hours records into 17 open access, 5 name hints, and 11 unknown", () => {
    const nullHours = realResult().places.filter((p) => p.hoursRaw === null);
    const count = (confidence: string) =>
      nullHours.filter((p) => p.hoursConfidence === confidence).length;
    expect(nullHours).toHaveLength(33);
    expect([count("open_access"), count("derived"), count("unknown")]).toEqual([17, 5, 11]);
  });

  it("closes the April-October places in winter via season rules", () => {
    for (const id of ["place_035", "place_063", "place_064", "place_085"]) {
      expect(place(id).dateRules).toEqual([
        {
          kind: "season",
          window: { from: { month: 4, day: 1 }, to: { month: 10, day: 31 } },
          source: "Open April-October only",
        },
      ]);
    }
    expect(place("place_090").dateRules[0]).toMatchObject({
      kind: "season",
      window: { from: { month: 10 } },
    });
    expect(place("place_065").dateRules[0]).toMatchObject({
      kind: "season",
      window: { from: { month: 5 }, to: { month: 9 } },
    });
  });

  it("rewrites local_favorite on the Aperitivo Culture Walk", () => {
    expect(place("place_100").tags).toContain("local-favorite");
    expect(place("place_100").tags).not.toContain("local_favorite");
  });

  it("keeps booking unknown for Il Sorpasso and marks booked places Book ahead", () => {
    expect(place("place_020").bookingRequired).toBeNull();
    expect(place("place_020").bookAhead).toBe(false);
    expect(place("place_056").bookAhead).toBe(true);
  });

  it("makes every restaurant and every allowlisted food place meal-capable, and nothing else", () => {
    for (const p of realResult().places) {
      const expected = p.type === "restaurant" || Object.hasOwn(EXTRA_MEAL_PLACES, p.id);
      expect(p.mealCapable, p.id).toBe(expected);
    }
    expect(place("place_015").meals).toEqual(["lunch"]);
    expect(place("place_068").meals).toEqual(["dinner"]);
  });

  it("maps every price symbol to a level and gives no place an unknown price", () => {
    for (const p of realResult().places) expect([1, 2, 3, 4]).toContain(p.priceLevel);
  });
});

describe("the real data's issue log is pinned", () => {
  // A normalizer or config change that moves any count fails here with a readable diff, so a
  // widened threshold (for example SAME_LOCATION_MAX_M 15 -> 500) cannot slip through.
  it("logs exactly these issues per kind", () => {
    const counts: Record<string, number> = {};
    for (const issue of realResult().issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
    expect(counts).toEqual({
      booking_missing: 1,
      coords_far_from_city: 1,
      date_restriction: 1,
      duration_exceeds_hours: 1,
      duration_missing: 9,
      duration_out_of_bounds: 1,
      hours_conflict: 1,
      hours_free_text: 5,
      hours_missing: 11,
      hours_name_hint: 5,
      hours_open_access: 17,
      hours_past_midnight: 1,
      low_rating: 1,
      meal_unavailable: 5,
      neighborhood_corrected: 2,
      neighborhood_missing: 19,
      note_info: 11,
      note_not_applied: 3,
      price_conflict: 4,
      same_experience: 2,
      season_restriction: 6,
      shared_location: 4,
      tag_variant: 1,
    });
  });

  it("links only the two Trevi listings, the two Mercato Centrale listings, and the balsamic pair", () => {
    const linked = realResult()
      .places.filter((p) => p.sharedLocationWith.length > 0)
      .map((p) => `${p.id}:${p.sharedLocationWith.join(",")}`);
    expect(linked).toEqual([
      "place_018:place_077",
      "place_030:place_031",
      "place_031:place_030",
      "place_044:place_083",
      "place_077:place_018",
      "place_083:place_044",
    ]);
  });

  it("moves the Uffizi and Buca dell'Orafo off the Oltrarno label, which is across the river", () => {
    expect(place("place_026").neighborhood).toBe("Piazza della Signoria");
    expect(place("place_033").neighborhood).toBeNull();
    expect(place("place_028").neighborhood).toBe("Oltrarno");
  });

  it("flags splurge-tagged places priced two euro signs, and keeps the listed price", () => {
    const conflicts = realResult().issues.filter((issue) => issue.kind === "price_conflict");
    expect(conflicts.map((issue) => issue.placeId)).toEqual([
      "place_007",
      "place_023",
      "place_035",
      "place_093",
    ]);
    expect(place("place_007").priceLevel).toBe(2);
  });
});
