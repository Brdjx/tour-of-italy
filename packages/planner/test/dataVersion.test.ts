import { describe, expect, it } from "vitest";
import { canonicalJson, dataVersion, hash64 } from "../src/dataVersion";
import { PlaceSchema } from "../src/schemas";
import { realContext } from "./plannerFixtures";

// The data fingerprint a saved trip carries. The API computes it over the places it serves and
// the browser over the places it loaded, so it must not depend on key order or on a JSON round
// trip, and it must change when any value does.

const places = realContext().places;

describe("canonicalJson", () => {
  it("sorts keys at every level and leaves out undefined values, like JSON.stringify", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"e":2,"f":1}]},"b":1}',
    );
    expect(canonicalJson([undefined, null, "x", Number.NaN])).toBe('[null,null,"x",null]');
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("hash64", () => {
  it("gives 16 hex characters that change with the text", () => {
    expect(hash64("")).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64("a")).not.toBe(hash64("b"));
    expect(hash64("roma")).toBe(hash64("roma"));
  });
});

describe("dataVersion", () => {
  it("is the same after the places travel as JSON and are parsed again, as in the browser", () => {
    const received = JSON.parse(JSON.stringify(places)) as unknown[];
    const parsed = received.map((place) => PlaceSchema.parse(place));

    expect(dataVersion(parsed)).toBe(dataVersion(places));
  });

  it("does not depend on the key order inside a place", () => {
    const reordered = places.map((place) =>
      Object.fromEntries(Object.entries(place).reverse()),
    ) as unknown as typeof places;

    expect(dataVersion(reordered)).toBe(dataVersion(places));
  });

  it("changes when any value changes, such as one place's hours or visit length", () => {
    const first = places[0];
    if (!first) throw new Error("no places");
    const longer = [{ ...first, durationMin: first.durationMin + 5 }, ...places.slice(1)];

    expect(dataVersion(longer)).not.toBe(dataVersion(places));
    expect(dataVersion(places.slice(1))).not.toBe(dataVersion(places));
  });
});
