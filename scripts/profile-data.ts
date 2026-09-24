// Field inventory of data/italy.json, written to docs/data-profile.md.
// Run with `pnpm data:profile`. It reads the raw file only; normalization is in the audit.
// The output is deterministic (no timestamps), so it only changes when the data changes.

import {
  FAR_FROM_CITY_KM,
  haversineKm,
  ITALY_BBOX,
  insideItaly,
  median,
  RawPlaceSchema,
  SAME_EXPERIENCE_GROUPS,
} from "@italy/planner";
import { cell, code, countValues, readDataset, table, writeDoc } from "./lib/markdown";

type Row = Record<string, unknown>;

// The expected raw fields are the keys of the tolerant raw schema the normalizer reads.
const FIELDS = Object.keys(RawPlaceSchema.shape);
const KEYWORDS =
  "closed|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend|summer|winter|seasonal|season|only|open|until|reservation|book|by appointment|night|dawn|morning|evening|month".split(
    "|",
  );
const OUTLIER_REVIEW_KM = 10;
const NEAR_DUPLICATE_M = 500;
const DISTINCT_FIELDS: [string, (row: Row) => unknown[]][] = [
  ["type", (row) => [row.type]],
  ["city", (row) => [row.city]],
  ["region", (row) => [row.region]],
  ["neighborhood", (row) => [row.neighborhood]],
  ["tags", (row) => (Array.isArray(row.tags) ? row.tags : [])],
  ["hours (every value, verbatim)", (row) => [row.hours]],
  ["duration_minutes", (row) => [row.duration_minutes]],
  ["price_range", (row) => [row.price_range]],
  ["rating", (row) => [row.rating]],
  ["booking_required", (row) => [row.booking_required]],
];

const jsType = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const num = (value: unknown) => (typeof value === "number" ? value : Number.NaN);

function fieldTable(rows: Row[]): string {
  const lines = FIELDS.map((field) => {
    const values = rows.map((row) => row[field]);
    const present = rows.filter((row) => Object.hasOwn(row, field)).length;
    const types = countValues(values.map(jsType))
      .map(([type, count]) => `${type} ${count}`)
      .join(", ");
    const distinct = new Set(values.map((value) => JSON.stringify(value))).size;
    return [
      code(field),
      `${Math.round((present / rows.length) * 100)}%`,
      types,
      String(values.filter((v) => v === null).length),
      String(values.filter((v) => v === "").length),
      String(distinct),
    ];
  });
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
    (key) => !FIELDS.includes(key),
  );
  const note =
    extra.length > 0
      ? `Fields not in the expected list: ${extra.map(code).join(", ")}.\n`
      : "No unexpected fields.\n";
  return `${table(["Field", "Present", "JS types", "Nulls", "Empty strings", "Distinct"], lines)}\n${note}`;
}

function distinctList(title: string, values: unknown[]): string {
  const rows = countValues(values.map((value) => (value === null ? "(null)" : String(value)))).map(
    ([value, count]) => [code(value), String(count)],
  );
  return `### ${title} (${rows.length} distinct)\n\n${table(["Value", "Records"], rows)}`;
}

function coordinateProblem(point: { lat: number; lng: number }): string {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return "missing or not a number";
  if (point.lat === 0 || point.lng === 0) return "zero";
  if (insideItaly(point)) return "";
  return insideItaly({ lat: point.lng, lng: point.lat }) ? "swapped" : "outside Italy";
}

function coordinates(rows: Row[]): string {
  const lats = rows.map((row) => num(row.latitude)).filter(Number.isFinite);
  const lngs = rows.map((row) => num(row.longitude)).filter(Number.isFinite);
  const problems: string[][] = [];
  for (const row of rows) {
    const point = { lat: num(row.latitude), lng: num(row.longitude) };
    const problem = coordinateProblem(point);
    if (problem) {
      problems.push([code(row.id), cell(row.name), code([row.latitude, row.longitude]), problem]);
    }
  }
  const bbox = `lat ${ITALY_BBOX.minLat} to ${ITALY_BBOX.maxLat}, lng ${ITALY_BBOX.minLng} to ${ITALY_BBOX.maxLng}`;
  return [
    "## Coordinates\n",
    `- Latitude: min ${Math.min(...lats)}, max ${Math.max(...lats)}`,
    `- Longitude: min ${Math.min(...lngs)}, max ${Math.max(...lngs)}`,
    `- Italy bounding box: ${bbox}\n`,
    "Records missing, zero, swapped, or outside the box:\n",
    table(["Id", "Name", "Lat, lng", "Problem"], problems),
  ].join("\n");
}

function cityOutliers(rows: Row[]): string {
  const byCity = new Map<string, Row[]>();
  for (const row of rows) {
    byCity.set(String(row.city), [...(byCity.get(String(row.city)) ?? []), row]);
  }
  const lines: string[][] = [];
  for (const [city, members] of byCity) {
    if (members.length < 3) continue;
    for (const row of members) {
      const others = members.filter((other) => other !== row);
      const centroid = {
        lat: median(others.map((o) => num(o.latitude))),
        lng: median(others.map((o) => num(o.longitude))),
      };
      const km = haversineKm({ lat: num(row.latitude), lng: num(row.longitude) }, centroid);
      if (km <= OUTLIER_REVIEW_KM) continue;
      const flag = km > FAR_FROM_CITY_KM ? "**far**" : "review";
      lines.push([cell(city), code(row.id), cell(row.name), km.toFixed(1), flag]);
    }
  }
  lines.sort((a, b) => Number(b[3]) - Number(a[3]));
  const small = [...byCity]
    .filter(([, members]) => members.length < 3)
    .map(([city, members]) => `${city} (${members.length})`);
  return [
    "## Distance from the city's other places\n",
    `Each place in a city with at least 3 places, measured against the median of the city's other places. Listed when over ${OUTLIER_REVIEW_KM} km; "far" means over ${FAR_FROM_CITY_KM} km.\n`,
    table(["City", "Id", "Name", "Km", "Flag"], lines),
    `\nCities with fewer than 3 places (not checked): ${small.join(", ")}.\n`,
  ].join("\n");
}

function duplicates(rows: Row[]): string {
  const fold = (value: unknown) =>
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const names = countValues(rows.map((row) => fold(row.name))).filter(([, count]) => count > 1);
  const points = countValues(rows.map((row) => `${row.latitude},${row.longitude}`)).filter(
    ([, count]) => count > 1,
  );
  const pointRows = points.map(([point]) => {
    const matches = rows.filter((row) => `${row.latitude},${row.longitude}` === point);
    return [code(point), matches.map((row) => `${code(row.id)} ${cell(row.name)}`).join("; ")];
  });
  const ids = rows.map((row) => row.id);
  const idProblems = [
    `- Missing ids: ${ids.filter((id) => typeof id !== "string" || id === "").length}`,
    `- Duplicate ids: ${countValues(ids).filter(([, count]) => count > 1).length}`,
    `- Ids matching \`place_NNN\`: ${ids.filter((id) => typeof id === "string" && /^place_\d{3}$/.test(id)).length} of ${ids.length}`,
  ];
  return [
    "## Duplicates and ids\n",
    `Duplicate names (case and punctuation ignored): ${names.length === 0 ? "none" : names.map(([name]) => code(name)).join(", ")}.\n`,
    "Identical coordinates:\n",
    table(["Lat, lng", "Records"], pointRows),
    idProblems.join("\n"),
    "",
  ].join("\n");
}

/** Same type, under NEAR_DUPLICATE_M apart, 3+ shared tags: listed for a person to review. */
function nearDuplicates(rows: Row[]): string {
  const lines: string[][] = [];
  const tagsOf = (row: Row) => (Array.isArray(row.tags) ? row.tags.map(String) : []);
  const pointOf = (row: Row) => ({ lat: num(row.latitude), lng: num(row.longitude) });
  rows.forEach((row, index) => {
    for (const other of rows.slice(index + 1)) {
      if (row.type !== other.type) continue;
      const meters = haversineKm(pointOf(row), pointOf(other)) * 1000;
      const shared = tagsOf(row).filter((tag) => tagsOf(other).includes(tag));
      if (!(meters < NEAR_DUPLICATE_M) || shared.length < 3) continue;
      const linked = SAME_EXPERIENCE_GROUPS.some(
        (group) => group.ids.includes(String(row.id)) && group.ids.includes(String(other.id)),
      );
      lines.push([
        `${code(row.id)} ${cell(row.name)}`,
        `${code(other.id)} ${cell(other.name)}`,
        String(Math.round(meters)),
        shared.join(", "),
        linked ? "linked in config" : "distinct",
      ]);
    }
  });
  return [
    "## Possible duplicate experiences\n",
    `Pairs of the same type under ${NEAR_DUPLICATE_M} m apart with at least 3 shared tags. Reviewed by hand: pairs that are the same experience are linked in \`SAME_EXPERIENCE_GROUPS\` so a trip includes only one.\n`,
    table(["Place", "Other place", "Meters", "Shared tags", "Review"], lines),
  ].join("\n");
}

function keywordScan(rows: Row[]): string {
  const lines: string[][] = [];
  for (const row of rows) {
    for (const field of ["seasonal_notes", "description"]) {
      const text = row[field];
      if (typeof text !== "string") continue;
      const found = KEYWORDS.filter((keyword) => new RegExp(`\\b${keyword}`, "i").test(text));
      if (found.length === 0) continue;
      lines.push([code(row.id), cell(row.name), field, found.join(", "), cell(text)]);
    }
  }
  return [
    "## Keyword scan of notes and descriptions\n",
    `Keywords: ${KEYWORDS.join(", ")}.\n`,
    table(["Id", "Name", "Field", "Keywords", "Text"], lines),
  ].join("\n");
}

function main(): void {
  const { raw, sha256, bytes } = readDataset();
  const shape = Array.isArray(raw)
    ? `array of ${raw.length}`
    : `${jsType(raw)} with keys ${Object.keys(raw ?? {}).join(", ")}`;
  const rows = (Array.isArray(raw) ? raw : []) as Row[];
  const notes = rows.filter((row) => typeof row.seasonal_notes === "string");
  writeDoc("data-profile.md", [
    "# Data profile: data/italy.json\n",
    "Generated by `pnpm data:profile` from the raw file. Values are shown verbatim, except that em and en dashes in source text appear as a hyphen.\n",
    `- Records: ${rows.length}`,
    `- Top level: ${shape}`,
    `- Size: ${bytes} bytes`,
    `- SHA-256: \`${sha256}\`\n`,
    "## Fields\n",
    fieldTable(rows),
    "## Distinct values\n",
    ...DISTINCT_FIELDS.map(([title, values]) => distinctList(title, rows.flatMap(values))),
    `## Seasonal notes (${notes.length} records)\n`,
    table(
      ["Id", "Name", "Note"],
      notes.map((row) => [code(row.id), cell(row.name), cell(row.seasonal_notes)]),
    ),
    coordinates(rows),
    cityOutliers(rows),
    duplicates(rows),
    nearDuplicates(rows),
    keywordScan(rows),
  ]);
}

main();
