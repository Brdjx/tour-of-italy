import type { DataSummary } from "@italy/planner";

// "About this data": what the planner found in the source data and how each issue was handled,
// in plain words, from GET /api/data-issues (or rebuilt from the places when that is missing).
// It sits at the foot of the page as a quiet link that opens the notes in place.

/** Place names listed per issue before "and N more". */
export const NAMES_SHOWN = 8;

export function DataNotesPanel({ summary }: { summary: DataSummary }) {
  return (
    <details className="data-notes" data-testid="data-notes">
      {/* Decision: no count on the link. "(23)" read as 23 problems; the headline inside says
          how the data stands in words, and the list below names each kind of note. */}
      <summary className="data-notes-link">About this data</summary>
      <div className="data-notes-body">
        <p className="text-sm text-fg" data-testid="data-headline">
          {summary.headline}
        </p>
        <ul className="mt-3 space-y-4">
          {summary.items.map((item) => (
            <li key={item.kind} className="max-w-prose">
              <p className="text-sm font-semibold text-fg">
                {item.title}{" "}
                <span className="font-normal text-muted">
                  ({item.count} {item.count === 1 ? "place" : "places"})
                </span>
              </p>
              <p className="text-sm text-fg">{item.explanation}</p>
              {item.places.length > 0 ? (
                <p className="mt-0.5 text-sm text-muted">{namesText(item.places)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** "Colosseum, Pantheon and 3 more". */
export function namesText(places: readonly { name: string }[]): string {
  const names = places.slice(0, NAMES_SHOWN).map((place) => place.name);
  const rest = places.length - names.length;
  if (rest > 0) return `${names.join(", ")} and ${rest} more`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
