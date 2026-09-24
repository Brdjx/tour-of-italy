"use client";

import type { Itinerary } from "@italy/planner";
import { useId, useState } from "react";
import type { PlanOrigin } from "../lib/itineraryReducer";
import { type SourceMarker, type SourceStatus, sourceText } from "../lib/sourceText";
import { ChevronIcon } from "./icons";

// Says who planned the trip, how it was checked, and whether it currently has problems. The
// label is always visible; the details (what the pipeline did, the fallback cause in plain
// words) open on tap, click, or Enter. The chevron shows it opens.

interface SourceBadgeProps extends SourceStatus {
  itinerary: Itinerary;
  origin: PlanOrigin;
}

const MARKER_CLASS: Record<SourceMarker, string> = {
  ai: "bg-accent", // matches the filled dot on AI-written reasons
  rules: "border-2 border-muted", // matches the open dot on rule-based reasons
  problem: "bg-danger",
};

export function SourceBadge({ itinerary, origin, ...status }: SourceBadgeProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const text = sourceText(itinerary, origin, status);
  return (
    <div
      className="min-w-0"
      data-testid="source-badge"
      data-source={itinerary.source}
      data-marker={text.marker}
    >
      <button
        type="button"
        className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-sm font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span
          aria-hidden="true"
          className={`inline-block size-2.5 shrink-0 rounded-full ${MARKER_CLASS[text.marker]}`}
        />
        <span
          data-testid={text.offline ? "offline-label" : undefined}
          className={text.marker === "problem" ? "text-danger" : undefined}
        >
          {text.label}
        </span>
        <span className="sr-only">. Show how this plan was made.</span>
        <ChevronIcon
          size={16}
          className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={detailsId}
        hidden={!open}
        className="mt-1 max-w-prose border-l-2 border-accent pl-3 text-sm text-fg"
        data-testid="source-details"
      >
        {text.details.map((sentence) => (
          <p key={sentence} className="mt-1 first:mt-0">
            {sentence}
          </p>
        ))}
      </div>
    </div>
  );
}
