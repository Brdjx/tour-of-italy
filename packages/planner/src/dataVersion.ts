import type { Place } from "./types";

// A short fingerprint of the place data, so a saved trip can tell whether the page has the data
// it was saved with. The API computes it over the places it serves (/api/places, and /api/meta
// reports it); the browser computes it over the places it loaded. Equal fingerprints mean equal
// data, so a saved trip's times and why lines still hold; different ones mean it is timed again.

// Decision: a 64-bit non-cryptographic hash (two 32-bit multiply-xorshift lanes, the cyrb53
// construction) over canonical JSON, not SHA-256. It runs synchronously in the browser with no
// Node import (crypto.subtle is async), and it only has to notice a change, not resist one: the
// fingerprint a saved trip carries comes from the API's own store, never from a link.

/** JSON with object keys sorted at every level and undefined values left out, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const item = (value as Record<string, unknown>)[key];
        return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
      });
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 16 hex characters for `text`. */
export function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1);
}

/** The fingerprint of a place list, in its order. Key order inside a place does not matter. */
export function dataVersion(places: readonly Place[]): string {
  return hash64(canonicalJson(places));
}
