// Number formatting for the report. Every helper returns "n/a" for a missing value, so a metric
// that does not apply never shows up as a misleading zero.

export const NA = "n/a";

export function percent(value: number | null): string {
  return value === null ? NA : `${Math.round(value * 100)}%`;
}

/** "93% (14/15)": a rate with the counts behind it. */
export function ratio(part: number, whole: number): string {
  if (whole === 0) return NA;
  return `${percent(part / whole)} (${part}/${whole})`;
}

export function decimal(value: number | null, digits = 1): string {
  return value === null ? NA : value.toFixed(digits);
}

export function minutes(value: number | null): string {
  return value === null ? NA : `${Math.round(value)} min`;
}

export function seconds(ms: number | null): string {
  return ms === null ? NA : `${(ms / 1000).toFixed(1)} s`;
}

export function tokens(value: number | null): string {
  return value === null ? NA : Math.round(value).toLocaleString("en-US");
}

export function usd(value: number | null): string {
  if (value === null) return NA;
  return value === 0 ? "$0" : `$${value.toFixed(4)}`;
}

/** A markdown table. Pipes inside cells are escaped so a value cannot break the table. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)];
}
