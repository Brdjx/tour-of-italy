import { buildAnchors } from "./anchors";
import type { Anchor, Place } from "./types";

// The planner's view of the data, built once per dataset. Everything downstream (scoring,
// constraints, the scheduler, the validator, swap alternatives) takes a PlannerContext instead of
// raw arrays, so every layer sees the same places, the same bases, and the same place-to-base map.

export interface PlannerContext {
  places: readonly Place[]; // schedulable places, in the order given
  placesById: ReadonlyMap<string, Place>; // every place by id
  anchors: readonly Anchor[]; // bases, most places first (see buildAnchors)
  anchorById: ReadonlyMap<string, Anchor>; // every base by id
  anchorIdByPlaceId: ReadonlyMap<string, string>; // the one base each place belongs to
}

/**
 * Builds the context from normalized places. Throws RangeError when two places share an id,
 * because every later lookup would silently pick one of them.
 */
// Decision: the context and its bases are frozen. In a warm Lambda or a long-lived browser tab
// the same context serves every plan, so a caller that sorted or edited it in place would corrupt
// later plans; frozen, that bug throws at once in tests instead.
export function buildPlannerContext(places: readonly Place[]): PlannerContext {
  const placesById = new Map<string, Place>();
  for (const place of places) {
    if (placesById.has(place.id)) {
      throw new RangeError(`Two places share the id "${place.id}"; ids must be unique`);
    }
    placesById.set(place.id, place);
  }
  const anchors = buildAnchors(places).map(freezeAnchor);
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const anchorIdByPlaceId = new Map<string, string>();
  for (const anchor of anchors) {
    for (const placeId of anchor.placeIds) anchorIdByPlaceId.set(placeId, anchor.id);
  }
  return Object.freeze({
    places: Object.freeze([...places]),
    placesById,
    anchors: Object.freeze(anchors),
    anchorById,
    anchorIdByPlaceId,
  });
}

/** The places of one base, in id order. Empty for an unknown base id. */
export function placesOfAnchor(ctx: PlannerContext, anchorId: string): Place[] {
  const anchor = ctx.anchorById.get(anchorId);
  if (!anchor) return [];
  const result: Place[] = [];
  for (const id of anchor.placeIds) {
    const place = ctx.placesById.get(id);
    if (place) result.push(place);
  }
  return result;
}

/** Symmetric same-spot links per context, built once: a link on either side counts. */
const twinsByContext = new WeakMap<PlannerContext, Map<string, string[]>>();

/**
 * The places that share a spot (or an experience) with this one, in either direction, as
 * sharesLocation answers it. Built once per context, so a check against a whole trip is cheap.
 */
export function twinIds(ctx: PlannerContext, placeId: string): readonly string[] {
  let twins = twinsByContext.get(ctx);
  if (!twins) {
    twins = new Map();
    for (const place of ctx.places) {
      for (const other of place.sharedLocationWith) {
        if (other === place.id) continue;
        twins.set(place.id, [...new Set([...(twins.get(place.id) ?? []), other])]);
        twins.set(other, [...new Set([...(twins.get(other) ?? []), place.id])]);
      }
    }
    twinsByContext.set(ctx, twins);
  }
  return twins.get(placeId) ?? [];
}

/** The base a place belongs to, or undefined for an unknown place id. */
export function anchorOfPlace(ctx: PlannerContext, placeId: string): Anchor | undefined {
  const anchorId = ctx.anchorIdByPlaceId.get(placeId);
  return anchorId === undefined ? undefined : ctx.anchorById.get(anchorId);
}

function freezeAnchor(anchor: Anchor): Anchor {
  Object.freeze(anchor.centroid);
  Object.freeze(anchor.placeIds);
  return Object.freeze(anchor);
}
