import type { DataIssue, Normalized } from "../types";
import { cleanText, makeIssue, slugify } from "./issue";

// Place ids. Source ids are kept when they are safe to put in a URL, a prompt, and a map key.
// A missing or unsafe id becomes a stable slug of city and name. Collisions get -2, -3, ...

const MAX_ID_LENGTH = 64;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface IdContext {
  index: number; // position in the source array, 0-based
  name: unknown; // raw name, for the slug
  city: unknown; // raw city, for the slug
}

/** Chooses an id for one record before any other field is read. Pure; never throws. */
export function normalizeId(raw: unknown, context: IdContext): Normalized<string> {
  if (typeof raw === "string" && SAFE_ID.test(raw)) return { value: raw, issues: [] };
  const slug = slugFor(context);
  const detail =
    raw === null || raw === undefined
      ? "No id"
      : "Id is not a short text of letters, digits, _ or -";
  const issue = makeIssue(
    { placeId: slug, field: "id" },
    "id_missing",
    raw ?? null,
    detail,
    `Used "${slug}"`,
  );
  return { value: slug, issues: [issue] };
}

/** "rome-colosseum" from city and name, or "record_12" when neither is usable. */
function slugFor(context: IdContext): string {
  const parts = [cleanText(context.city), cleanText(context.name)].filter((part) => part !== null);
  const slug = slugify(parts.join(" ")).slice(0, 60).replace(/-+$/, "");
  return slug.length > 0 ? slug : `record_${context.index + 1}`;
}

/**
 * Makes ids unique: the first record keeps its id, later ones get -2, -3, and so on. Returns
 * the final ids (same order) and one issue per renamed record.
 */
export function resolveIdCollisions(ids: string[]): { ids: string[]; issues: DataIssue[] } {
  const used = new Set(ids);
  const seen = new Set<string>();
  const nextSuffix = new Map<string, number>(); // keeps 10,000 copies of one id linear
  const finalIds: string[] = [];
  const issues: DataIssue[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      finalIds.push(id);
      continue;
    }
    let suffix = nextSuffix.get(id) ?? 2;
    while (used.has(withSuffix(id, suffix))) suffix++;
    nextSuffix.set(id, suffix + 1);
    const renamed = withSuffix(id, suffix);
    used.add(renamed);
    seen.add(renamed);
    finalIds.push(renamed);
    const detail = `Id "${id}" is already used by an earlier record`;
    const target = { placeId: renamed, field: "id" };
    issues.push(makeIssue(target, "id_duplicate", id, detail, `Renamed to "${renamed}"`));
  }
  return { ids: finalIds, issues };
}

/** `id-2`, with the id shortened first when needed so the result stays within 64 characters. */
// Decision: without the cut, two 64-character ids would produce a 66-character id that fails
// IdSchema, and one bad id would make the web app reject the whole /api/places response.
function withSuffix(id: string, suffix: number): string {
  const tail = `-${suffix}`;
  return `${id.slice(0, MAX_ID_LENGTH - tail.length)}${tail}`;
}
