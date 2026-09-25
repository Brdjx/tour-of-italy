import { createHash } from "node:crypto";
import type { Context } from "hono";

// HTTP caching for the read-only routes. Their bodies change only with a deploy, so they are
// serialized once, carry a strong ETag, and tell browsers and CloudFront how long to reuse them.
// A saved trip never changes, so it may be reused too. Everything else (plans, health, errors)
// is sent with no-store.

// Decision: browsers reuse the data for 5 minutes, then revalidate with If-None-Match (a 304 of a
// few bytes instead of 130 KB). Shared caches such as CloudFront may keep it for an hour; a
// deploy that changes the data invalidates /api/* there. Every page load needs /api/meta and
// /api/places, so without this each one reaches the function.
export const CACHE_CONTROL = {
  data: "public, max-age=300, s-maxage=3600",
  // Decision: a saved trip may be reused as is. It is written once (a conditional put under a
  // new id) and no route changes it afterwards; it can only expire, and a copy at most 5 minutes
  // old of a trip that just expired is harmless. Errors, a 404 included, stay no-store.
  savedTrip: "public, max-age=300, immutable",
  never: "no-store",
} as const;

/** A JSON body serialized once, with its ETag. */
export interface PreparedJson {
  body: string;
  etag: string;
}

export function prepareJson(value: unknown): PreparedJson {
  const body = JSON.stringify(value);
  const hash = createHash("sha256").update(body).digest("base64url").slice(0, 32);
  return { body, etag: `"${hash}"` };
}

/** True when an If-None-Match header lists this ETag (weak or strong) or "*". */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  for (const entry of header.split(",")) {
    const tag = entry.trim().replace(/^W\//, "");
    if (tag === "*" || tag === etag) return true;
  }
  return false;
}

/** Sends a prepared body with Cache-Control and ETag; a matching If-None-Match gets a 304. */
export function sendPreparedJson(c: Context, prepared: PreparedJson): Response {
  c.header("Cache-Control", CACHE_CONTROL.data);
  c.header("ETag", prepared.etag);
  if (etagMatches(c.req.header("if-none-match"), prepared.etag)) return c.body(null, 304);
  c.header("Content-Type", "application/json");
  return c.body(prepared.body, 200);
}
