import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePlaces } from "../src/normalize/index";
import type { NormalizeResult, Place } from "../src/types";

// Shared fixtures for planner tests: the real dataset, read the same way the API reads it.

export const DATA_PATH = fileURLToPath(new URL("../../../data/italy.json", import.meta.url));

/** The raw bytes of data/italy.json. */
export function readDataBytes(): Buffer {
  return readFileSync(DATA_PATH);
}

/** The raw dataset as parsed JSON (a fresh copy each call, so tests can mutate it). */
export function rawData(): Record<string, unknown>[] {
  return JSON.parse(readDataBytes().toString("utf8")) as Record<string, unknown>[];
}

let cached: NormalizeResult | null = null;

/** normalizePlaces over the real dataset, computed once per test file. */
export function realResult(): NormalizeResult {
  cached ??= normalizePlaces(rawData());
  return cached;
}

/** A normalized real place by id; throws when missing so a renamed id fails loudly. */
export function place(id: string): Place {
  const found = realResult().places.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No place ${id} in the normalized data`);
  return found;
}

/** A valid raw record in Rome's Celio neighborhood, with fields overridden. */
export function rawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "place_900",
    name: "Test Place",
    type: "museum",
    city: "Rome",
    region: "Lazio",
    neighborhood: "Celio",
    description: "A test record.",
    latitude: 41.8951, // near Campo de' Fiori, not on top of any real place
    longitude: 12.4801,
    hours: "9:00-19:00",
    duration_minutes: 120,
    price_range: "€€",
    rating: 4.5,
    tags: ["historic"],
    seasonal_notes: null,
    booking_required: false,
    ...overrides,
  };
}

/** Normalizes the real dataset plus extra records appended at the end. */
export function withExtraRecords(...records: unknown[]): NormalizeResult {
  return normalizePlaces([...rawData(), ...records]);
}
