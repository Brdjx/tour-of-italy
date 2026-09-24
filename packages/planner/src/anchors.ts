import { DAY_TRIP_MAX_KM, MIN_PLACES_FOR_BASE } from "./config";
import { haversineKm, type LatLng, median } from "./normalize/geo";
import { UNKNOWN_CITY } from "./normalize/locations";
import { travelMinutes } from "./travel";
import type { Anchor, Place, TripRequest } from "./types";

// Bases ("anchors"). A city with at least MIN_PLACES_FOR_BASE places is a base. Every other place
// joins its nearest base within DAY_TRIP_MAX_KM as a day trip; a place farther than that from
// every base becomes a base of its own. Each place belongs to exactly one base, and a day only
// visits places of its base.

/** The fields buildAnchors reads. Accepting this subset keeps tests small. */
export type AnchorSource = Pick<Place, "id" | "name" | "city" | "region" | "lat" | "lng">;

/** Longest base id before a collision suffix, so ids stay within the 64-character id limit. */
const SLUG_MAX = 56;

interface Draft {
  name: string; // base name shown to the traveler
  key: string; // member ids, to order drafts that share a name
  members: AnchorSource[]; // the places that define the centroid and region
  centroid: LatLng;
  placeIds: string[]; // members plus attached day-trip places
}

/** Kebab-case id for a base name: "Isola della Scala" becomes "isola-della-scala". */
export function anchorSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining accents: "Forli" from "Forlì"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "base" : slug;
}

/**
 * Builds the bases from normalized places. Pure and independent of input order: base ids,
 * members, centroids, and the output order are the same for any permutation of `places`.
 * Output is sorted by number of places (most first), then id.
 */
export function buildAnchors(places: readonly AnchorSource[]): Anchor[] {
  // Decision: sort by id once, here. Every later step keeps that order or sorts its own output,
  // which is what makes the result the same for any input order.
  const byCity = groupByCity(sortById(places));
  const bases: Draft[] = [];
  const outsiders: AnchorSource[] = [];
  for (const [city, members] of byCity) {
    // Decision: "Unknown city" is a placeholder the normalizer uses when it could not infer a
    // city, never a real town, so it can never become a base however many places share it.
    if (city !== UNKNOWN_CITY && members.length >= MIN_PLACES_FOR_BASE) {
      bases.push(draftFor(city, members));
    } else {
      outsiders.push(...members);
    }
  }
  const orphans: AnchorSource[] = [];
  for (const place of outsiders) {
    const base = nearestBase(place, bases);
    if (base) base.placeIds.push(place.id);
    else orphans.push(place);
  }
  // Decision: real bases take their ids first, so an orphan that happens to share a base city's
  // name ("Rome" in "Unknown city") becomes rome-2 and never renames the real Rome base.
  return finalize([...sortDrafts(bases), ...sortDrafts(orphanBases(orphans))]);
}

/** Travel minutes between two bases' centroids; 0 when the base does not change. */
export function transferMinutes(from: Anchor, to: Anchor): number {
  if (from.id === to.id) return 0;
  return travelMinutes(from.centroid, to.centroid);
}

/**
 * Where a day at this base starts and ends: the base's centroid. The scheduler, the validator,
 * the look-ahead, scoring, and swaps all take a day's first leg and its trip back from here.
 */
// Decision: one function for the day's start point, and it takes the request although it does
// not read it yet. A "start from a hotel" extension adds the hotel to the request and changes
// only this body; every caller already passes the request.
export function dayOrigin(anchor: Anchor, _request: TripRequest): LatLng {
  return anchor.centroid;
}

// ---------- Helpers ----------

/** Places by city, keeping the given order inside each city. */
function groupByCity(places: readonly AnchorSource[]): Map<string, AnchorSource[]> {
  const groups = new Map<string, AnchorSource[]>();
  for (const place of places) {
    const group = groups.get(place.city);
    if (group) group.push(place);
    else groups.set(place.city, [place]);
  }
  return groups;
}

/** A draft base; its centroid is the median of its members (every draft has at least one). */
function draftFor(name: string, members: AnchorSource[]): Draft {
  const centroid = {
    lat: median(members.map((m) => m.lat)),
    lng: median(members.map((m) => m.lng)),
  };
  const placeIds = members.map((m) => m.id);
  return { name, key: placeIds.join(" "), members, centroid, placeIds };
}

/** The nearest base within DAY_TRIP_MAX_KM (inclusive); ties go to the lower base name. */
function nearestBase(place: AnchorSource, bases: Draft[]): Draft | null {
  let best: { draft: Draft; km: number } | null = null;
  for (const draft of bases) {
    const km = haversineKm(place, draft.centroid);
    if (km > DAY_TRIP_MAX_KM) continue;
    const closer = best === null || km < best.km;
    const tieWins = best !== null && km === best.km && draft.name < best.draft.name;
    if (closer || tieWins) best = { draft, km };
  }
  return best?.draft ?? null;
}

/**
 * Places too far from every base. Places of the same named city share one base (two places in
 * Naples make one Naples base). A place in "Unknown city" is a base of its own, named after the
 * place, because the placeholder says nothing about where it is.
 */
// Decision: orphan cities do not absorb each other as day trips. That would need a second pass
// with its own tie rules for a case the data does not have; the brief asks for "its own base".
function orphanBases(orphans: AnchorSource[]): Draft[] {
  const drafts: Draft[] = [];
  for (const [city, members] of groupByCity(orphans)) {
    if (city === UNKNOWN_CITY) {
      for (const member of members) drafts.push(draftFor(member.name, [member]));
    } else {
      drafts.push(draftFor(city, members));
    }
  }
  return drafts;
}

/** Most common region among the members; ties go to the alphabetically first region. */
function majorityRegion(members: AnchorSource[]): string {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.region, (counts.get(member.region) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [region, count] of counts) {
    if (count > bestCount || (count === bestCount && region < best)) {
      best = region;
      bestCount = count;
    }
  }
  return best;
}

/** Drafts in name order, ties by member ids, so id suffixes never depend on input order. */
function sortDrafts(drafts: Draft[]): Draft[] {
  return [...drafts].sort((a, b) => compareText(a.name, b.name) || compareText(a.key, b.key));
}

/** Assigns unique ids in the given order, then sorts by size and id. */
function finalize(drafts: Draft[]): Anchor[] {
  const used = new Set<string>();
  const anchors: Anchor[] = [];
  for (const draft of drafts) {
    const id = uniqueId(anchorSlug(draft.name), used);
    anchors.push({
      id,
      name: draft.name,
      region: majorityRegion(draft.members),
      centroid: { lat: draft.centroid.lat, lng: draft.centroid.lng },
      placeIds: [...draft.placeIds].sort(compareText),
    });
  }
  return anchors.sort((a, b) => b.placeIds.length - a.placeIds.length || compareText(a.id, b.id));
}

function uniqueId(slug: string, used: Set<string>): string {
  let id = slug;
  for (let n = 2; used.has(id); n++) id = `${slug}-${n}`;
  used.add(id);
  return id;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareText(a.id, b.id));
}

/**
 * Plain code-unit order. Decision: never localeCompare, whose order depends on the runtime's
 * locale data, so the browser and the Lambda could disagree.
 */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
