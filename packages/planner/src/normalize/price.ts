import type { DataIssue, Normalized, PriceLevel } from "../types";
import { lookup, makeIssue } from "./issue";

// Price level 1..4 from "€".."€€€€". Also reads "$$", plain numbers, and a few words, so a
// differently formatted dataset still works with the budget filter.

const PRICE_WORDS: Record<string, PriceLevel> = {
  free: 1,
  gratis: 1,
  cheap: 1,
  budget: 1,
  inexpensive: 1,
  low: 1,
  moderate: 2,
  medium: 2,
  mid: 2,
  expensive: 3,
  high: 3,
  luxury: 4,
  "very expensive": 4,
};

export interface PriceContext {
  placeId: string;
  tags: string[]; // canonical tags, to spot free, budget, and splurge conflicts
}

/** Normalizes price_range. Pure; never throws. */
export function normalizePrice(raw: unknown, context: PriceContext): Normalized<PriceLevel | null> {
  const target = { placeId: context.placeId, field: "price_range" };
  const issues: DataIssue[] = [];
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    const action = "Price unknown: passes every budget filter";
    return {
      value: null,
      issues: [makeIssue(target, "price_missing", raw ?? null, "No price listed", action)],
    };
  }
  const symbols = typeof raw === "string" ? /^\s*(€{1,4}|\${1,4})\s*$/.exec(raw) : null;
  let level: PriceLevel | null = symbols ? ((symbols[1] ?? "").length as PriceLevel) : null;
  if (level !== null && symbols?.[1]?.startsWith("$")) {
    issues.push(
      makeIssue(target, "price_format", raw, "Price uses $ signs", `Read as level ${level}`),
    );
  }
  if (level === null) {
    level = otherFormat(raw);
    if (level === null) {
      const action = "Price unknown: passes every budget filter";
      return {
        value: null,
        issues: [makeIssue(target, "price_unparsed", raw, "Price not understood", action)],
      };
    }
    issues.push(
      makeIssue(target, "price_format", raw, "Price not in € symbols", `Read as level ${level}`),
    );
  }
  const conflict = tagConflict(context.tags, level);
  if (conflict) {
    const detail = `Tagged ${conflict} but priced ${"€".repeat(level)}`;
    const action =
      conflict === "free"
        ? `Kept price level ${level}; the budget filter treats free and € the same`
        : `Kept price level ${level}; the listed price decides the budget filter`;
    issues.push(makeIssue(target, "price_conflict", raw, detail, action));
  }
  return { value: level, issues };
}

/** A price tag the level contradicts: free with any price, budget at €€€+, splurge at €€ or less. */
// Decision: the listed price always wins, because it is the field the budget filter reads; the
// conflict is logged so a reviewer can fix the source.
function tagConflict(tags: string[], level: PriceLevel): string | null {
  if (tags.includes("free")) return "free";
  if (tags.includes("budget") && level >= 3) return "budget";
  if (tags.includes("splurge") && level <= 2) return "splurge";
  return null;
}

/** Numbers 0..4 (0 is free, read as 1) and price words. */
function otherFormat(raw: unknown): PriceLevel | null {
  const number =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  if (Number.isInteger(number) && number >= 0 && number <= 4) {
    // Decision: a free place is level 1, the lowest budget option.
    return Math.max(1, number) as PriceLevel;
  }
  if (typeof raw !== "string") return null;
  return lookup(PRICE_WORDS, raw.trim().toLowerCase()) ?? null;
}
