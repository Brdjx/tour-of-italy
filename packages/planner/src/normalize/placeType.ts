import { OPEN_ACCESS_TYPES, PUBLIC_SPACE_ALIASES } from "../config";
import { type Normalized, PLACE_TYPES, type PlaceType } from "../types";
import { cleanText, foldText, lookup, makeIssue } from "./issue";

// Place type. The ten types in the data pass through; common synonyms map to one of them; anything
// else becomes "other" (default duration, never meal-capable, never open access).

/** Synonyms to a known type, keyed by folded text with spaces as underscores. */
export const TYPE_ALIASES: Record<string, PlaceType> = {
  trattoria: "restaurant",
  osteria: "restaurant",
  ristorante: "restaurant",
  pizzeria: "restaurant",
  bar: "cafe",
  caffe: "cafe",
  coffee: "cafe",
  gelateria: "cafe",
  wine_bar: "cafe",
  gallery: "museum",
  church: "historic_site",
  basilica: "historic_site",
  cathedral: "historic_site",
  monument: "historic_site",
  landmark: "historic_site",
  ruins: "historic_site",
  square: "historic_site",
  piazza: "historic_site",
  lookout: "viewpoint",
  panorama: "viewpoint",
  garden: "park",
  gardens: "park",
  tour: "experience",
  class: "experience",
  activity: "experience",
  day_trip: "experience",
  district: "neighborhood",
  quarter: "neighborhood",
  store: "shop",
  boutique: "shop",
  food_market: "market",
};

/** Normalizes type. Pure; never throws. */
export function normalizeType(raw: unknown, context: { placeId: string }): Normalized<PlaceType> {
  const target = { placeId: context.placeId, field: "type" };
  const text = cleanText(raw);
  if (text === null) {
    const action = 'Used "other" with default visit length';
    return {
      value: "other",
      issues: [makeIssue(target, "type_unknown", raw ?? null, "No type", action)],
    };
  }
  const key = foldText(text).replace(/\s+/g, "_");
  const known = PLACE_TYPES.find((type) => type === key && type !== "other");
  if (known) {
    if (known === raw) return { value: known, issues: [] };
    return {
      value: known,
      issues: [
        makeIssue(target, "type_variant", raw, "Casing or spacing differs", `Used "${known}"`),
      ],
    };
  }
  const alias = lookup(TYPE_ALIASES, key);
  if (alias) {
    return {
      value: alias,
      issues: [
        makeIssue(
          target,
          "type_variant",
          raw,
          `"${text}" is a kind of ${alias}`,
          `Used "${alias}"`,
        ),
      ],
    };
  }
  const action = 'Used "other" with default visit length';
  return {
    value: "other",
    issues: [makeIssue(target, "type_unknown", raw, `Unknown type "${text}"`, action)],
  };
}

/**
 * True when the raw type names a public space (an open-access type, or "square", "piazza",
 * "lookout", ...), so a record without hours is open access. Aliases such as "church" or "ruins"
 * map to historic_site for display but are not public spaces.
 */
export function isPublicSpace(raw: unknown): boolean {
  const text = cleanText(raw);
  if (text === null) return false;
  const key = foldText(text).replace(/\s+/g, "_");
  return (
    (OPEN_ACCESS_TYPES as readonly string[]).includes(key) || PUBLIC_SPACE_ALIASES.includes(key)
  );
}
