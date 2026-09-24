import { ISSUE_RAW_MAX_CHARS, ISSUE_TEXT_MAX_CHARS } from "../config";
import type { DataIssue, IssueKind } from "../types";

// Small helpers shared by every normalizer: building issues and reading raw text safely.

/** The placeId used for problems with the dataset as a whole, not one record. */
export const DATASET_ISSUE_ID = "dataset";

/** Where an issue belongs: the place id and the raw field name. */
export interface IssueTarget {
  placeId: string;
  field: string;
}

/** Builds a DataIssue. `raw` is any value; it is stored as short JSON text. */
export function makeIssue(
  target: IssueTarget,
  kind: IssueKind,
  raw: unknown,
  detail: string,
  action: string,
): DataIssue {
  return {
    placeId: target.placeId,
    field: target.field,
    kind,
    raw: rawText(raw),
    detail: cut(detail, ISSUE_TEXT_MAX_CHARS),
    action: cut(action, ISSUE_TEXT_MAX_CHARS),
  };
}

/**
 * A raw value as short JSON text for data notes. Never throws: values JSON cannot represent
 * (BigInt, cycles, functions) fall back to String().
 */
export function rawText(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = safeString(value);
  }
  return cut(text, ISSUE_RAW_MAX_CHARS);
}

/** Text cut to `max` characters, ending in "..." when it was longer. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Trims, collapses runs of whitespace, and removes control characters. Returns null when the
 * value is not a string or nothing is left.
 */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Lowercase, accents removed, punctuation folded to spaces: for matching, never for display. */
export function foldText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents split off by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A URL-safe slug: "Castel Sant'Angelo" becomes "castel-sant-angelo". */
export function slugify(value: string): string {
  return foldText(value).replace(/\s+/g, "-");
}

/**
 * Looks up a key in a plain-object table, ignoring inherited properties. Without this, data such
 * as a city named "constructor" or a price of "__proto__" would read Object's own members.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** True for a plain object record (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
