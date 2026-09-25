import {
  type DaySelection,
  IdSchema,
  type Itinerary,
  type PlannerContext,
  TRIP_DAYS,
  type TripRequest,
  TripRequestSchema,
} from "@italy/planner";
import { z } from "zod";
import { fromBase64Url, toBase64Url } from "./base64url";
import { rebuildValid } from "./shareRebuild";

// Shareable plan links. `?p=` holds base64url JSON { v: 1, request, days: [{ anchorId, ids }] }:
// ids and order only, never times, so a shared plan is always retimed and checked with the
// current data and rules. Decoding treats the link as hostile input: every failure ends in a
// safe result (no plan, a trip form to fill in, or a plan with bad stops left out) plus a note
// that says what happened. It never throws.

export const SHARE_PARAM = "p";
export const SHARE_VERSION = 1;
/** Longest `?p=` value accepted, in characters. A 3-day plan encodes to well under 1 KB. */
export const SHARE_MAX_CHARS = 8 * 1024;

const ShareDaySchema = z.strictObject({
  anchorId: IdSchema,
  ids: z.array(IdSchema).max(20),
});

const SharePayloadSchema = z.strictObject({
  v: z.literal(SHARE_VERSION),
  request: TripRequestSchema,
  days: z.array(ShareDaySchema).length(TRIP_DAYS),
});

export type SharePayload = z.input<typeof SharePayloadSchema>;
export type ParsedSharePayload = z.output<typeof SharePayloadSchema>;

export type ShareDecode =
  | { status: "none" } // no link in the URL
  | { status: "plan"; itinerary: Itinerary; note: string } // rebuilt and valid
  | { status: "request"; request: TripRequest; note: string } // settings only; plan again
  | { status: "invalid"; note: string }; // nothing usable

// Decision: no "below" or "above". The note sits over the form on phones and beside it on wide
// screens, so the words point at the form, not at a direction.
export const SHARE_NOTES = {
  damaged: "This shared link is damaged and could not be opened. Plan a new trip with the form.",
  tooLong: "This shared link is too long to open. Plan a new trip with the form.",
  version:
    "This shared link comes from another version of the app and could not be opened. Plan a new trip with the form.",
  stale:
    "This shared plan no longer fits the current data. Its trip settings are filled in, so you can plan it again.",
  opened: "Opened a shared plan. Times were worked out again with the current data.",
} as const;

/** The payload for an itinerary. Notes are left out: they are private and do not shape the plan. */
export function sharePayload(itinerary: Itinerary): SharePayload {
  const { notes: _notes, ...request } = itinerary.request;
  return {
    v: SHARE_VERSION,
    request,
    days: itinerary.days.map((day) => ({
      anchorId: day.anchorId,
      ids: day.stops.map((stop) => stop.placeId),
    })),
  };
}

/** The `?p=` value for an itinerary. */
export function encodeShare(itinerary: Itinerary): string {
  return toBase64Url(JSON.stringify(sharePayload(itinerary)));
}

/** A full link: `base` is the page URL without a query, e.g. origin plus pathname. */
export function shareUrl(itinerary: Itinerary, base: string): string {
  return `${base}?${SHARE_PARAM}=${encodeShare(itinerary)}`;
}

/** The raw `?p=` value from a query string, or null. */
export function readShareParam(search: string): string | null {
  try {
    return new URLSearchParams(search).get(SHARE_PARAM);
  } catch {
    return null;
  }
}

/** Decodes a `?p=` value against the loaded places. Never throws. */
export function decodeShare(
  param: string | null,
  ctx: PlannerContext,
  generatedAt: string,
): ShareDecode {
  if (param === null || param === "") return { status: "none" };
  if (param.length > SHARE_MAX_CHARS) return { status: "invalid", note: SHARE_NOTES.tooLong };
  const payload = parsePayload(param);
  if (typeof payload === "string") return { status: "invalid", note: payload };
  try {
    return rebuildShared(payload, ctx, generatedAt);
  } catch {
    // Decision: the rebuild runs planner code on data a stranger wrote. Anything it throws on is
    // treated as a damaged link rather than a crash of the whole page.
    return { status: "invalid", note: SHARE_NOTES.damaged };
  }
}

/** The validated payload, or the note explaining why there is none. */
function parsePayload(param: string): z.output<typeof SharePayloadSchema> | string {
  const text = fromBase64Url(param);
  if (text === null) return SHARE_NOTES.damaged;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return SHARE_NOTES.damaged;
  }
  if (json && typeof json === "object" && "v" in json && json.v !== SHARE_VERSION) {
    return SHARE_NOTES.version;
  }
  const parsed = SharePayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : SHARE_NOTES.damaged;
}

/** The notes a rebuild from ids ends with: opened (then what was left out), or stale. */
export interface RebuildNotes {
  opened: string;
  stale: string;
}

/**
 * Rebuilds a trip from its request and ids with the loaded places: the ?p= link's path, and a
 * saved trip's when the place data changed since it was saved. Throws only on planner errors.
 */
export function rebuildShared(
  payload: ParsedSharePayload,
  ctx: PlannerContext,
  generatedAt: string,
  notes: RebuildNotes = SHARE_NOTES,
): Extract<ShareDecode, { status: "plan" | "request" }> {
  const cleaned = cleanRequest(payload.request, ctx);
  const excluded = new Set(cleaned.request.exclude);
  const seen = new Set<string>();
  let droppedIds = 0;
  const selection: DaySelection[] = payload.days.map((day) => {
    const placeIds = day.ids.filter((id) => {
      const keep = ctx.placesById.has(id) && !excluded.has(id) && !seen.has(id);
      seen.add(id);
      if (!keep) droppedIds += 1;
      return keep;
    });
    return { anchorId: day.anchorId, placeIds };
  });
  if (selection.some((day) => !ctx.anchorById.has(day.anchorId))) {
    return { status: "request", request: cleaned.request, note: notes.stale };
  }
  const rebuilt = rebuildValid(cleaned.request, selection, ctx, generatedAt);
  if (!rebuilt) return { status: "request", request: cleaned.request, note: notes.stale };
  return {
    status: "plan",
    itinerary: rebuilt.itinerary,
    note: openedNote(notes.opened, droppedIds + rebuilt.dropped, cleaned.changed),
  };
}

/** The request with values the data no longer has removed. */
function cleanRequest(request: TripRequest, ctx: PlannerContext) {
  const tags = new Set(ctx.places.flatMap((place) => place.tags));
  const interests = request.interests.filter((tag) => tags.has(tag));
  const mustInclude = request.mustInclude.filter((id) => ctx.placesById.has(id));
  const exclude = request.exclude.filter((id) => ctx.placesById.has(id));
  const chosen = request.anchors === "auto" ? [] : request.anchors;
  const known = chosen.filter((id) => ctx.anchorById.has(id));
  const anchors: TripRequest["anchors"] = known.length > 0 ? known : "auto";
  const changed =
    interests.length !== request.interests.length ||
    mustInclude.length !== request.mustInclude.length ||
    exclude.length !== request.exclude.length ||
    known.length !== chosen.length;
  const { notes: _notes, ...rest } = request;
  return { request: { ...rest, interests, mustInclude, exclude, anchors }, changed };
}

function openedNote(opened: string, dropped: number, settingsChanged: boolean): string {
  const parts: string[] = [opened];
  if (dropped > 0) {
    const stops = dropped === 1 ? "1 stop" : `${dropped} stops`;
    parts.push(
      `${stops} from the link no longer fit and ${dropped === 1 ? "was" : "were"} left out.`,
    );
  }
  if (settingsChanged) parts.push("Some trip settings in the link are no longer offered.");
  return parts.join(" ");
}
