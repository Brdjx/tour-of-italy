import { z } from "zod";
import type { DataIssue } from "../types";
import { DATASET_ISSUE_ID, isRecord, makeIssue } from "./issue";

// The raw source format, as found in data/italy.json. Every field is optional and unknown:
// the normalizers read and check each one, so a record with a wrong type still becomes a place
// (with issues) instead of failing validation as a whole.

export const RawPlaceSchema = z.looseObject({
  id: z.unknown().optional(), // "place_001"
  name: z.unknown().optional(), // display name
  type: z.unknown().optional(), // one of the ten place types
  city: z.unknown().optional(), // English city name
  region: z.unknown().optional(), // English region name
  neighborhood: z.unknown().optional(), // text or null
  description: z.unknown().optional(), // prose
  latitude: z.unknown().optional(), // number
  longitude: z.unknown().optional(), // number
  hours: z.unknown().optional(), // text such as "Tues-Sun 9:00-19:00", or null
  duration_minutes: z.unknown().optional(), // number or null
  price_range: z.unknown().optional(), // "€" to "€€€€"
  rating: z.unknown().optional(), // 0 to 5
  tags: z.unknown().optional(), // list of text
  seasonal_notes: z.unknown().optional(), // text or null
  booking_required: z.unknown().optional(), // true, false, or null
});

export type RawPlace = z.infer<typeof RawPlaceSchema>;

/** The list of records at the top level, tolerating { "places": [...] } style wrappers. */
export function readTopLevel(raw: unknown): { records: unknown[]; issues: DataIssue[] } {
  const target = { placeId: DATASET_ISSUE_ID, field: "(top level)" };
  if (Array.isArray(raw)) return { records: raw, issues: [] };
  if (isRecord(raw)) {
    const lists = Object.entries(raw).filter(([, value]) => Array.isArray(value));
    const only = lists.length === 1 ? lists[0] : undefined;
    if (only) {
      const detail = `The places are under the key "${only[0]}" instead of at the top level`;
      const issue = makeIssue(
        target,
        "dataset_shape",
        Object.keys(raw),
        detail,
        "Read the places from that key",
      );
      return { records: only[1] as unknown[], issues: [issue] };
    }
  }
  const detail = "The file is not a list of places";
  const issue = makeIssue(target, "dataset_shape", typeName(raw), detail, "No places loaded");
  return { records: [], issues: [issue] };
}

/** Parses one record tolerantly. Null when it is not an object at all. */
export function readRecord(record: unknown): RawPlace | null {
  if (!isRecord(record)) return null;
  const parsed = RawPlaceSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
}

export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
