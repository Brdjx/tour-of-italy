import type { DataSummary, DataSummaryItem, IssueKind, NormalizeResult } from "../types";
import { ISSUE_KIND_TEXT } from "./issueText";

// Builds the plain-language "About this data" summary from a normalize result. The API serves
// it from GET /api/data-issues and the web app shows it in the data notes panel.

const DISPLAY_ORDER = Object.keys(ISSUE_KIND_TEXT) as IssueKind[];

/** Plain-language summary of what the normalizer found and did. Pure. */
export function buildDataSummary(result: NormalizeResult): DataSummary {
  const records = result.places.length + result.excluded.length;
  const names = new Map<string, string>();
  for (const place of result.places) names.set(place.id, place.name);
  for (const record of result.excluded) names.set(record.id, record.name ?? record.id);

  const placesByKind = new Map<IssueKind, string[]>();
  for (const issue of result.issues) {
    const ids = placesByKind.get(issue.kind) ?? [];
    if (!ids.includes(issue.placeId)) ids.push(issue.placeId);
    placesByKind.set(issue.kind, ids);
  }

  const items: DataSummaryItem[] = [];
  for (const kind of DISPLAY_ORDER) {
    const ids = placesByKind.get(kind);
    if (!ids) continue;
    items.push({
      kind,
      title: ISSUE_KIND_TEXT[kind].title,
      explanation: ISSUE_KIND_TEXT[kind].explanation,
      count: ids.length,
      places: ids.map((id) => ({ id, name: names.get(id) ?? id })),
    });
  }

  return {
    totals: {
      records,
      schedulable: result.places.length,
      excluded: result.excluded.length,
      issues: result.issues.length,
    },
    headline: headline(records, result.places.length),
    items,
  };
}

function headline(records: number, schedulable: number): string {
  if (records === 0) return "No places could be loaded.";
  const noun = records === 1 ? "place" : "places";
  if (schedulable === records) {
    return `${records} ${noun} loaded, ${records === 1 ? "usable" : "all usable"} for planning.`;
  }
  return `${records} ${noun} loaded, ${schedulable} usable for planning and ${records - schedulable} left out.`;
}
