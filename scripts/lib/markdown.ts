import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Small helpers shared by the data scripts: reading the dataset and writing Markdown.

export const DATA_PATH = fileURLToPath(new URL("../../data/italy.json", import.meta.url));
export const DOCS_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/** The dataset bytes, parsed JSON, and checksum. */
export function readDataset(): { raw: unknown; sha256: string; bytes: number } {
  const buffer = readFileSync(DATA_PATH);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { raw: JSON.parse(buffer.toString("utf8")) as unknown, sha256, bytes: buffer.length };
}

/**
 * Text safe for a Markdown table cell. Em and en dashes from the source are shown as " - " so the
 * generated docs follow the project's prose rule; pipes and newlines are escaped.
 */
export function cell(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text
    .replaceAll(EM_DASH, "-")
    .replaceAll(EN_DASH, "-")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ");
}

/** Inline code cell, for raw values shown verbatim. */
export function code(value: unknown): string {
  return `\`${cell(value).replaceAll("`", "'")}\``;
}

/** A Markdown table. Rows are arrays of already formatted cells. */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_None._\n";
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return `${lines.join("\n")}\n`;
}

/** Counts of each value, most common first, ties in first-seen order. */
export function countValues<T>(values: T[]): [T, number][] {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Writes a generated doc and reports it. */
export function writeDoc(name: string, sections: string[]): void {
  const path = `${DOCS_DIR}${name}`;
  const text = `${sections.join("\n").trimEnd()}\n`;
  if (text.includes(EM_DASH)) throw new Error(`${name} would contain an em dash`);
  writeFileSync(path, text);
  console.log(`Wrote docs/${name} (${text.split("\n").length} lines)`);
}
