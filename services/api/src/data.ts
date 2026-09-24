import {
  buildDataset,
  buildPlannerContext,
  type Dataset,
  INTEREST_EXCLUDED_TAGS,
  type KnownValues,
  type PlannerContext,
} from "@italy/planner";
import rawPlaces from "../../../data/italy.json" with { type: "json" };

// The dataset, normalized once per process. esbuild inlines data/italy.json into the Lambda
// bundle, so a cold start does no file I/O and the deployed data is exactly the tested data.

export interface AppData {
  dataset: Dataset; // normalized places, excluded records, issues, and the summary
  ctx: PlannerContext; // bases and lookups every plan uses
  known: KnownValues; // what a trip request may refer to
  interestTags: string[]; // tags offered as interests, most common first
}

/** Tags offered as interests with their place counts, most common first, ties by tag. */
export function interestCounts(dataset: Dataset): Map<string, number> {
  const excluded = new Set(INTEREST_EXCLUDED_TAGS);
  const counts = new Map<string, number>();
  for (const place of dataset.places) {
    for (const tag of place.tags) {
      if (!excluded.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

/** Normalizes raw JSON and builds everything the routes need. Pure. */
export function buildAppData(raw: unknown): AppData {
  const dataset = buildDataset(raw);
  const ctx = buildPlannerContext(dataset.places);
  const interestTags = [...interestCounts(dataset).keys()];
  const known: KnownValues = {
    tags: new Set(interestTags),
    placeIds: new Set(ctx.placesById.keys()),
    anchorIds: new Set(ctx.anchorById.keys()),
  };
  return { dataset, ctx, known, interestTags };
}

let shipped: AppData | undefined;

/** The shipped dataset, built on first use and reused for the life of the process. */
export function shippedData(): AppData {
  shipped ??= buildAppData(rawPlaces as unknown);
  return shipped;
}
