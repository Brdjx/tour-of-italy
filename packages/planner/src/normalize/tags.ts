import type { DataIssue, Normalized } from "../types";
import { foldText, lookup, makeIssue } from "./issue";

// Tags are lowercase kebab-case ("local_favorite" becomes "local-favorite"), deduplicated, in
// source order. tagLabel turns a tag into display text ("Local favorite").

/** Spelling variants to the canonical tag. */
export const TAG_SYNONYMS: Record<string, string> = {
  "local-favourite": "local-favorite",
  "family-friendy": "family-friendly",
  "hidden-gems": "hidden-gem",
};

/** Canonical form of one tag, or null when nothing usable is left. */
export function canonicalTag(text: string): string | null {
  const kebab = foldText(text).replace(/\s+/g, "-");
  if (kebab === "") return null;
  return lookup(TAG_SYNONYMS, kebab) ?? kebab;
}

/** Display label: "local-favorite" becomes "Local favorite". */
export function tagLabel(tag: string): string {
  const words = tag.replace(/-/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Normalizes tags. Pure; never throws. */
export function normalizeTags(raw: unknown, context: { placeId: string }): Normalized<string[]> {
  const target = { placeId: context.placeId, field: "tags" };
  if (!Array.isArray(raw)) {
    const detail = raw === null || raw === undefined ? "No tags" : "Tags are not a list";
    return {
      value: [],
      issues: [makeIssue(target, "tags_missing", raw ?? null, detail, "Used no tags")],
    };
  }
  const tags: string[] = [];
  const issues: DataIssue[] = [];
  for (const item of raw) {
    const tag = typeof item === "string" ? canonicalTag(item) : null;
    if (tag === null) {
      issues.push(
        makeIssue(
          target,
          "tag_invalid",
          item ?? null,
          "Tag is empty or not text",
          "Dropped the tag",
        ),
      );
      continue;
    }
    if (tags.includes(tag)) {
      issues.push(makeIssue(target, "tag_variant", item, `Repeats "${tag}"`, "Dropped the repeat"));
      continue;
    }
    if (tag !== item) {
      issues.push(
        makeIssue(target, "tag_variant", item, "Tag not in lowercase kebab-case", `Used "${tag}"`),
      );
    }
    tags.push(tag);
  }
  return { value: tags, issues };
}
