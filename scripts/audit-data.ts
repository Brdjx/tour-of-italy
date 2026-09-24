// Normalization report for data/italy.json, written to docs/data-issues.md.
// Run with `pnpm data:audit` whenever a normalizer changes. It runs the same buildDataset the API
// uses, so this file is the evidence for every data decision the app makes.

import {
  buildDataset,
  CITY_ALIASES,
  type Dataset,
  EXTRA_MEAL_PLACES,
  NEIGHBORHOOD_CORRECTIONS,
  REGION_ALIASES,
  SAME_EXPERIENCE_GROUPS,
  TYPE_ALIASES,
} from "@italy/planner";
import { cell, code, countValues, readDataset, table, writeDoc } from "./lib/markdown";

type RawRow = Record<string, unknown>;

function totals(dataset: Dataset, sha256: string): string {
  const { summary } = dataset;
  return [
    "## Totals\n",
    `- Records in the file: ${summary.totals.records}`,
    `- Places usable for planning: ${summary.totals.schedulable}`,
    `- Records left out: ${summary.totals.excluded}`,
    `- Issues logged: ${summary.totals.issues}`,
    `- Source checksum (SHA-256): \`${sha256}\`\n`,
  ].join("\n");
}

/** The plain-language summary the API serves to the "About this data" panel. */
function aboutThisData(dataset: Dataset): string {
  const rows = dataset.summary.items.map((item) => [
    cell(item.title),
    String(item.count),
    cell(item.explanation),
  ]);
  return [
    "## About this data (as shown in the app)\n",
    `${dataset.summary.headline}\n`,
    table(["Note", "Places", "What it means"], rows),
  ].join("\n");
}

function countsByKind(dataset: Dataset): string {
  const rows = dataset.summary.items.map((item) => {
    const issues = dataset.issues.filter((issue) => issue.kind === item.kind).length;
    return [code(item.kind), String(issues), String(item.count), cell(item.title)];
  });
  return ["## Issues by kind\n", table(["Kind", "Issues", "Places", "Title"], rows)].join("\n");
}

function issueTables(dataset: Dataset): string {
  const names = new Map<string, string>();
  for (const place of dataset.places) names.set(place.id, place.name);
  for (const record of dataset.excluded) names.set(record.id, record.name ?? "(no name)");
  const sections = ["## Every issue, by kind\n"];
  for (const item of dataset.summary.items) {
    const rows = dataset.issues
      .filter((issue) => issue.kind === item.kind)
      .map((issue) => [
        `${code(issue.placeId)} ${cell(names.get(issue.placeId) ?? "")}`,
        code(issue.field),
        issue.raw === null ? "" : code(issue.raw),
        cell(issue.detail),
        cell(issue.action),
      ]);
    sections.push(`### ${cell(item.title)} (\`${item.kind}\`)\n`);
    sections.push(table(["Place", "Field", "Raw value", "Detail", "Action"], rows));
  }
  return sections.join("\n");
}

function excludedRecords(dataset: Dataset): string {
  const rows = dataset.excluded.map((record) => [
    code(record.id),
    cell(record.name ?? ""),
    record.reason,
    cell(record.detail),
  ]);
  return ["## Records left out\n", table(["Id", "Name", "Reason", "Detail"], rows)].join("\n");
}

/** The canonical maps, and which entries this data actually used. */
function nameMaps(dataset: Dataset, rows: RawRow[]): string {
  const rawById = new Map(rows.map((row) => [String(row.id), row]));
  const applied = (field: "city" | "region" | "type") => {
    const pairs = dataset.places.map((place) => {
      const rawValue = rawById.get(place.id)?.[field] ?? "(generated id, no raw match)";
      return `${String(rawValue)} -> ${place[field]}`;
    });
    return countValues(pairs).map(([pair, count]) => [code(pair), String(count)]);
  };
  const aliases = (map: Record<string, string>) =>
    Object.entries(map)
      .map(([from, to]) => `${from} -> ${to}`)
      .join(", ");
  return [
    "## Canonical names applied\n",
    "Raw value -> normalized value, for every usable place.\n",
    "### Cities\n",
    table(["Mapping", "Records"], applied("city")),
    "### Regions\n",
    table(["Mapping", "Records"], applied("region")),
    "### Types\n",
    table(["Mapping", "Records"], applied("type")),
    "### Alias tables available\n",
    `- Cities: ${aliases(CITY_ALIASES)}`,
    `- Regions: ${aliases(REGION_ALIASES)}`,
    `- Types: ${aliases(TYPE_ALIASES)}\n`,
  ].join("\n");
}

function mealPlaces(dataset: Dataset): string {
  const restaurants = dataset.places.filter((place) => place.type === "restaurant");
  const both = restaurants.filter((place) => place.meals.join("+") === "lunch+dinner");
  const limited = restaurants
    .filter((place) => place.meals.join("+") !== "lunch+dinner")
    .map((place) => {
      const why = place.issues.find((issue) => issue.kind === "meal_unavailable");
      return [
        code(place.id),
        cell(place.name),
        place.meals.join(", ") || "none",
        cell(why?.detail ?? ""),
      ];
    });
  const extras = Object.entries(EXTRA_MEAL_PLACES).map(([id, entry]) => {
    const place = dataset.byId.get(id);
    return [
      code(id),
      cell(place?.name ?? "(not in the data)"),
      entry.meals.join(", "),
      place ? place.meals.join(", ") || "none" : "",
      cell(entry.reason),
    ];
  });
  return [
    "## Meal places\n",
    `${both.length} of ${restaurants.length} restaurants can serve lunch and dinner. A meal is offered only when some open day can hold the whole visit with a start inside the meal window, so these restaurants serve one meal:\n`,
    table(["Id", "Name", "Meals", "Why"], limited),
    "These other places are on the reviewed allowlist in `config.ts` (the same hours check applies):\n",
    table(["Id", "Name", "Allowlisted", "After the hours check", "Reason"], extras),
  ].join("\n");
}

/** Hand-reviewed corrections in config, and the places a reviewer should look at next. */
function reviewedTables(dataset: Dataset): string {
  const corrections = Object.entries(NEIGHBORHOOD_CORRECTIONS).map(([id, entry]) => [
    code(id),
    cell(dataset.byId.get(id)?.name ?? "(not in the data)"),
    cell(entry.from),
    cell(entry.to ?? "(city shown)"),
    cell(entry.reason),
  ]);
  const groups = SAME_EXPERIENCE_GROUPS.map((group) => [
    group.ids
      .map((id) => `${code(id)} ${cell(dataset.byId.get(id)?.name ?? "(not in the data)")}`)
      .join(", "),
    cell(group.reason),
  ]);
  const pricedPublic = dataset.places
    .filter((place) => place.hoursConfidence === "open_access" && (place.priceLevel ?? 1) > 1)
    .map((place) => [code(place.id), cell(place.name), "€".repeat(place.priceLevel ?? 1)]);
  return [
    "## Reviewed corrections\n",
    "### Neighborhood labels corrected\n",
    table(["Id", "Name", "Listed", "Shown", "Reason"], corrections),
    "### Same experience, never in one trip\n",
    table(["Places", "Reason"], groups),
    "### Open-access places priced above €\n",
    "Free to enter, but a traveler with a low budget limit never sees them. Review the price or leave it if it reflects what people spend there.\n",
    table(["Id", "Name", "Price"], pricedPublic),
  ].join("\n");
}

function main(): void {
  const { raw, sha256 } = readDataset();
  const dataset = buildDataset(raw);
  const rows = (Array.isArray(raw) ? raw : []) as RawRow[];
  writeDoc("data-issues.md", [
    "# Data issues: data/italy.json\n",
    "Generated by `pnpm data:audit` from the normalizer in `packages/planner/src/normalize`. Raw values are shown verbatim, except that em and en dashes in source text appear as a hyphen. Guiding rule: source notes can only make hours stricter, never looser.\n",
    totals(dataset, sha256),
    aboutThisData(dataset),
    countsByKind(dataset),
    excludedRecords(dataset),
    mealPlaces(dataset),
    reviewedTables(dataset),
    nameMaps(dataset, rows),
    issueTables(dataset),
  ]);
}

main();
