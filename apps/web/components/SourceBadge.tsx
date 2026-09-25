"use client";

import type { Itinerary } from "@italy/planner";
import type { PlanOrigin } from "../lib/itineraryReducer";
import { type SourceMarker, type SourceStatus, sourceText } from "../lib/sourceText";

// The source line: one factual line under the trip's dates that says how the plan was made
// (lib/sourceText.ts), and why for a plan made without the AI. It is not a control; what the
// words mean in general is in About this data. The mark before it is a check that draws itself
// when a plan arrives, because every plan shown has passed the check against hours and travel
// time: gold for the AI planner, ink for the rules. A plan with a problem gets a red dot instead,
// never a check, and the count to fix after the claim.

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
  const text = sourceText(itinerary, origin, status);
  return (
    <p
      className="source-line"
      data-testid="source-badge"
      data-source={itinerary.source}
      data-marker={text.marker}
    >
      <SourceMark marker={text.marker} />
      <span className="source-text">
        <span data-testid={text.offline ? "offline-label" : undefined}>{text.claim}</span>
        {text.problem ? (
          <>
            , <span className="source-problem text-danger">{text.problem}</span>
          </>
        ) : (
          // Decision: the check says "checked" to the eye; this says it to a screen reader.
          <span className="sr-only">, checked against opening hours and travel time</span>
        )}
      </span>
    </p>
  );
}
