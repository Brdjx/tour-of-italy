import { NEIGHBORHOOD_CORRECTIONS } from "../config";
import type { Normalized } from "../types";
import { cleanText, foldText, lookup, makeIssue } from "./issue";

// Text fields: name, city, region, neighborhood, description. Cities and regions map to one
// canonical English name so filters and bases group correctly ("Roma" and "Rome" are one city).

/** Italian and variant city names to the canonical English name, keyed by folded text. */
export const CITY_ALIASES: Record<string, string> = {
  roma: "Rome",
  firenze: "Florence",
  venezia: "Venice",
  milano: "Milan",
  napoli: "Naples",
  torino: "Turin",
  genova: "Genoa",
  padova: "Padua",
  mantova: "Mantua",
  siracusa: "Syracuse",
};

/** Italian and variant region names to the canonical English name, keyed by folded text. */
export const REGION_ALIASES: Record<string, string> = {
  toscana: "Tuscany",
  lombardia: "Lombardy",
  "emilia romagna": "Emilia-Romagna",
  piemonte: "Piedmont",
  sicilia: "Sicily",
  sardegna: "Sardinia",
  puglia: "Apulia",
  "valle d aosta": "Aosta Valley",
  "trentino alto adige": "Trentino-Alto Adige",
  "friuli venezia giulia": "Friuli-Venezia Giulia",
};

type Target = { placeId: string };

/** The place name, cleaned. Null (and the record is excluded) when there is no usable name. */
export function normalizeName(raw: unknown, context: Target): Normalized<string | null> {
  const target = { placeId: context.placeId, field: "name" };
  const name = cleanText(raw);
  if (name === null) {
    const action = "Excluded: a place without a name cannot be shown";
    return {
      value: null,
      issues: [makeIssue(target, "name_missing", raw ?? null, "No usable name", action)],
    };
  }
  const issues =
    name === raw
      ? []
      : [
          makeIssue(
            target,
            "name_variant",
            raw,
            "Extra whitespace or control characters",
            `Cleaned to "${name}"`,
          ),
        ];
  return { value: name, issues };
}

/** Canonical English city name. Null when missing; index.ts then infers it from neighbors. */
export function normalizeCity(raw: unknown, context: Target): Normalized<string | null> {
  return canonicalPlaceName(raw, context, "city", CITY_ALIASES);
}

/** Canonical English region name. Null when missing; index.ts fills it from the city. */
export function normalizeRegion(raw: unknown, context: Target): Normalized<string | null> {
  return canonicalPlaceName(raw, context, "region", REGION_ALIASES);
}

function canonicalPlaceName(
  raw: unknown,
  context: Target,
  field: "city" | "region",
  aliases: Record<string, string>,
): Normalized<string | null> {
  const target = { placeId: context.placeId, field };
  const text = cleanText(raw);
  if (text === null) {
    const action =
      field === "city" ? "Inferred from the nearest place" : "Taken from the city's other places";
    return {
      value: null,
      issues: [makeIssue(target, `${field}_missing`, raw ?? null, `No ${field}`, action)],
    };
  }
  const alias = lookup(aliases, foldText(text));
  const cased = text === text.toLowerCase() || text === text.toUpperCase() ? titleCase(text) : text;
  const value = alias ?? cased;
  if (value === raw) return { value, issues: [] };
  const detail = alias ? `"${text}" is a variant of ${alias}` : "Casing or whitespace differs";
  return { value, issues: [makeIssue(target, `${field}_variant`, raw, detail, `Used "${value}"`)] };
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/** Neighborhood for display only. Null means the UI shows the city instead. */
export function normalizeNeighborhood(raw: unknown, context: Target): Normalized<string | null> {
  const target = { placeId: context.placeId, field: "neighborhood" };
  const text = cleanText(raw);
  if (text === null) {
    return {
      value: null,
      issues: [
        makeIssue(
          target,
          "neighborhood_missing",
          raw ?? null,
          "No neighborhood",
          "Shown as the city",
        ),
      ],
    };
  }
  const correction = lookup(NEIGHBORHOOD_CORRECTIONS, context.placeId);
  if (correction && foldText(correction.from) === foldText(text)) {
    const shown = correction.to ?? "the city";
    const detail = `Listed as "${text}": ${correction.reason}`;
    const issue = makeIssue(target, "neighborhood_corrected", raw, detail, `Shown as ${shown}`);
    return { value: correction.to, issues: [issue] };
  }
  return { value: text, issues: [] };
}

/** Description text, empty when missing. */
export function normalizeDescription(raw: unknown, context: Target): Normalized<string> {
  const target = { placeId: context.placeId, field: "description" };
  const text = cleanText(raw);
  if (text === null) {
    return {
      value: "",
      issues: [
        makeIssue(
          target,
          "description_missing",
          raw ?? null,
          "No description",
          "Shown without one",
        ),
      ],
    };
  }
  return { value: text, issues: [] };
}

/** booking_required: true, false, or null when the source does not say. */
export function normalizeBooking(raw: unknown, context: Target): Normalized<boolean | null> {
  const target = { placeId: context.placeId, field: "booking_required" };
  if (typeof raw === "boolean") return { value: raw, issues: [] };
  if (raw === null || raw === undefined) {
    const action = "Unknown: no Book ahead chip unless a note advises booking";
    return {
      value: null,
      issues: [
        makeIssue(target, "booking_missing", raw ?? null, "Booking requirement not stated", action),
      ],
    };
  }
  const action = "Treated as not stated";
  return {
    value: null,
    issues: [
      makeIssue(target, "booking_invalid", raw, "Booking requirement is not true or false", action),
    ],
  };
}
