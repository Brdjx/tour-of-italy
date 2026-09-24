import type { DataSummary } from "@italy/planner";
import { ChevronIcon } from "./icons";

// "About this data": what the planner found in the source data and how each issue was handled,
// in plain words, from GET /api/data-issues (or rebuilt from the places when that is missing).

/** Place names listed per issue before "and N more". */
export const NAMES_SHOWN = 8;

export function DataNotesPanel({ summary }: { summary: DataSummary }) {
  return (
    <details className="data-notes group" data-testid="data-notes">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-md text-base font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {/* Decision: no count here. "(23)" read as 23 problems; the headline says how the data
            stands in words, and the list below names each kind of note. */}
        <span className="py-2">
          <span className="block">About this data</span>
          <span className="block text-sm font-normal text-muted" data-testid="data-headline">
            {summary.headline}
          </span>
        </span>
        <ChevronIcon
          size={18}
          className="shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
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
