"use client";

import type { Itinerary } from "@italy/planner";
import { useId, useState } from "react";
import type { PlanOrigin } from "../lib/itineraryReducer";
import { type SourceMarker, type SourceStatus, sourceText } from "../lib/sourceText";
import { ChevronIcon } from "./icons";

// Says who planned the trip, how it was checked, and whether it currently has problems. The
// label is always visible; the details (what the pipeline did, the fallback cause in plain
// words) open on tap, click, or Enter. The chevron after the label shows it opens. The mark before the label is
// a check that draws itself when a plan arrives, because every plan shown has passed the check
// against hours and distance: gold for the AI planner, ink for the rules. A plan with a problem
// gets a red dot instead, never a check.

interface SourceBadgeProps extends SourceStatus {
  itinerary: Itinerary;
  origin: PlanOrigin;
}

/** The drawn check for a checked plan, or the red dot for a plan with a problem. */
function SourceMark({ marker }: { marker: SourceMarker }) {
  if (marker === "problem")
    return <span aria-hidden="true" className="source-mark source-mark--problem" />;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={`source-mark source-mark--${marker}`}
      viewBox="0 0 20 20"
      width={20}
      height={20}
    >
      <circle className="source-mark-ring" cx={10} cy={10} r={8.5} pathLength={1} />
      <path className="source-mark-check" d="M6 10.4 8.7 13 14 7.4" pathLength={1} />
    </svg>
  );
}

export function SourceBadge({ itinerary, origin, ...status }: SourceBadgeProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const text = sourceText(itinerary, origin, status);
  return (
    <div
      className="source-badge min-w-0"
      data-testid="source-badge"
      data-source={itinerary.source}
      data-marker={text.marker}
    >
      <button
        type="button"
        className="source-button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <SourceMark marker={text.marker} />
        {/* Decision: the chevron runs on after the last word, so a label that wraps on a phone
            still ends in its disclosure mark instead of leaving it stranded at the far edge. */}
        <span className="source-text">
          <span
            data-testid={text.offline ? "offline-label" : undefined}
            className={text.marker === "problem" ? "text-danger" : undefined}
          >
            {text.label}
          </span>
          <span className="sr-only">. Show how this plan was made.</span>
          <ChevronIcon
            size={16}
            className={`source-chevron${open ? " source-chevron--open" : ""}`}
          />
        </span>
      </button>
      <div id={detailsId} hidden={!open} className="source-details" data-testid="source-details">
        {text.details.map((sentence) => (
          <p key={sentence} className="mt-1 first:mt-0">
            {sentence}
          </p>
        ))}
      </div>
    </div>
  );
}
