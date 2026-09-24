import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// JSON text laid out the way Biome formats it, so committed recordings pass `pnpm lint` exactly
// as the runner writes them. Biome keeps objects expanded when the source has them expanded and
// puts an array on one line when it fits the line width. Recordings only hold short arrays of
// strings (interests, ids), so those are the only arrays written inline.

/** Biome's line width for this repo (biome.json). */
export const LINE_WIDTH = 100;

const INDENT = "  ";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPrimitive(value: Json): value is null | boolean | number | string {
  return value === null || typeof value !== "object";
}

/**
 * One value, starting after `lead` characters on its line and followed by `tail` characters
 * (a comma, or nothing).
 */
function render(value: Json, depth: number, lead: number, tail: number): string {
  if (isPrimitive(value)) return JSON.stringify(value);
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => JSON.stringify(item));
    const inline = `[${items.join(", ")}]`;
    // Decision: only arrays of primitives go inline. An object inside an array is written
    // expanded, and Biome then breaks the array too.
    if (value.every(isPrimitive) && lead + inline.length + tail <= LINE_WIDTH) return inline;
    const lines = value.map((item, index) => {
      const comma = index < value.length - 1 ? 1 : 0;
      return `${inner}${render(item, depth + 1, inner.length, comma)}`;
    });
    return `[\n${lines.join(",\n")}\n${pad}]`;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([key, item], index) => {
    const head = `${inner}${JSON.stringify(key)}: `;
    const comma = index < entries.length - 1 ? 1 : 0;
    return `${head}${render(item, depth + 1, head.length, comma)}`;
  });
  return `{\n${lines.join(",\n")}\n${pad}}`;
}

/** The value as formatted JSON text with a final newline. Undefined object fields are left out. */
export function formatJson(value: unknown): string {
  // A round trip first drops undefined fields and functions the way JSON.stringify does.
  const plain = JSON.parse(JSON.stringify(value)) as Json;
  return `${render(plain, 0, 0, 0)}\n`;
}

/** Writes formatted JSON, creating the folder when needed. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatJson(value));
}
