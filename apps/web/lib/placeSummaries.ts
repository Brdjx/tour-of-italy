import file from "./placeSummaries.data.json";

// Short summaries of the places, written once by Claude from each place's own listing and saved
// in placeSummaries.data.json by `pnpm summaries:generate` (scripts/generate-place-summaries.ts).
// Each one passed the code check in placeSummaryCheck.ts, and the unit tests run that check again
// over the saved file. A place the check refused twice has no summary, and its sheet shows none.
// Every row records the model, the prompt version and the day that wrote it. Run the script
// again rather than editing the file by hand.

interface SummaryRow {
  placeId: string;
  text: string;
  model: string;
  writtenOn: string; // YYYY-MM-DD
}

const ROWS: readonly SummaryRow[] = file.summaries;

const byPlace = new Map<string, SummaryRow>(ROWS.map((row) => [row.placeId, row]));

/** The saved summary of a place, or null when it has none. */
export function summaryForPlace(placeId: string): string | null {
  return byPlace.get(placeId)?.text ?? null;
}

/** Who wrote the summaries of a set of places, and when, for "About this data". */
export interface SummaryRecord {
  count: number; // how many of the places have a summary
  models: string[]; // the models that wrote them, in order
  firstDay: string | null; // YYYY-MM-DD
  lastDay: string | null;
}

/** How many of these places have a summary, which models wrote them and on which days. */
export function summaryRecord(placeIds: readonly string[]): SummaryRecord {
  const rows = placeIds.flatMap((id) => byPlace.get(id) ?? []);
  const days = [...new Set(rows.map((row) => row.writtenOn))].sort();
  return {
    count: rows.length,
    models: [...new Set(rows.map((row) => row.model))].sort(),
    firstDay: days[0] ?? null,
    lastDay: days.at(-1) ?? null,
  };
}
