import type { DataIssue, Place } from "../types";
import { normalizeDuration } from "./duration";
import { normalizePoint } from "./geo";
import { normalizeHours } from "./hours";
import { normalizeMeals } from "./meals";
import {
  normalizeBooking,
  normalizeCity,
  normalizeDescription,
  normalizeName,
  normalizeNeighborhood,
  normalizeRegion,
} from "./names";
import { isPublicSpace, normalizeType } from "./placeType";
import { normalizePrice } from "./price";
import { normalizeRating } from "./rating";
import { normalizeSeasonalNote, scanDescription } from "./seasons";
import { normalizeTags } from "./tags";

// Normalizes one record field by field. Cross-record work (city inference, duplicates, location
// repair, shared locations) happens afterwards in index.ts on the drafts this returns.

/** A place before the cross-record steps: some fields may still be missing. */
export interface PlaceDraft
  extends Omit<Place, "name" | "city" | "region" | "lat" | "lng" | "locationSource"> {
  sourceIndex: number; // position in the source array
  name: string | null; // null excludes the record
  city: string | null; // null is inferred from the nearest place
  region: string | null; // null is taken from the city's other places
  location: DraftLocation | null; // null until repaired from sibling places
  closed: boolean; // the hours or a note say the place is shut: excluded
}

export interface DraftLocation {
  lat: number;
  lng: number;
  source: Place["locationSource"];
}

/** Normalizes every field of one record. Pure; never throws. */
export function normalizeRecord(
  raw: Record<string, unknown>,
  id: string,
  sourceIndex: number,
): PlaceDraft {
  const context = { placeId: id };
  const issues: DataIssue[] = [];
  const take = <T>(result: { value: T; issues: DataIssue[] }): T => {
    issues.push(...result.issues);
    return result.value;
  };

  const name = take(normalizeName(raw.name, context));
  const type = take(normalizeType(raw.type, context));
  const city = take(normalizeCity(raw.city, context));
  const region = take(normalizeRegion(raw.region, context));
  const neighborhood = take(normalizeNeighborhood(raw.neighborhood, context));
  const description = take(normalizeDescription(raw.description, context));
  const tags = take(normalizeTags(raw.tags, context));
  const publicSpace = isPublicSpace(raw.type);
  const hours = take(
    normalizeHours(raw.hours, { placeId: id, type, name: name ?? "", publicSpace }),
  );
  const listedHours = hours.confidence === "listed" ? hours.hours : null;
  const notes = take(normalizeSeasonalNote(raw.seasonal_notes, { placeId: id, listedHours }));
  const noteRules = [...hours.dateRules, ...notes.dateRules];
  const descriptionRules = take(
    scanDescription(raw.description, { placeId: id, listedHours, existingRules: noteRules }),
  );
  const dateRules = [...noteRules, ...descriptionRules];
  const duration = take(
    normalizeDuration(raw.duration_minutes, { placeId: id, type, hours: hours.hours }),
  );
  const priceLevel = take(normalizePrice(raw.price_range, { placeId: id, tags }));
  const rating = take(normalizeRating(raw.rating, context));
  const point = take(normalizePoint({ latitude: raw.latitude, longitude: raw.longitude }, context));
  const bookingRequired = take(normalizeBooking(raw.booking_required, context));
  const meals = take(
    normalizeMeals({
      placeId: id,
      type,
      hours: hours.hours,
      durationMin: duration.durationMin,
      dateRules,
    }),
  );

  return {
    id,
    sourceIndex,
    name,
    type,
    city,
    region,
    neighborhood,
    description,
    location: point,
    hours: hours.hours,
    hoursConfidence: hours.confidence,
    hoursRaw: hours.hoursRaw,
    hoursDerivation: hours.derivation,
    dateRules,
    seasonalNote: notes.seasonalNote,
    durationMin: duration.durationMin,
    durationSource: duration.durationSource,
    priceLevel,
    rating,
    tags,
    bookingRequired,
    bookAhead: bookingRequired === true || notes.bookAdvice,
    mealCapable: meals.length > 0,
    meals,
    sharedLocationWith: [],
    issues,
    closed: hours.closed || notes.closed,
  };
}
