"use client";

import type { TripRequest } from "@italy/planner";
import { tripSummaryText } from "../lib/tripSummary";
import { EditIcon } from "./icons";
import { Skeleton } from "./skeleton/Skeleton";

// The trip form folded into one line once a plan is on screen or on its way:
// "Thu 15 Oct to Sat 17 Oct, balanced pace, 2 options", with "Edit trip" to open the form again.
// While a shared or saved plan is still loading there is no request to describe yet, so the
// line and the button are skeletons of the same size.

interface TripSummaryProps {
  request: TripRequest | null;
  onEdit: () => void;
}

export function TripSummary({ request, onEdit }: TripSummaryProps) {
  if (!request) {
    return (
      <div className="trip-summary" aria-hidden="true" data-testid="trip-summary-skeleton">
        <div className="trip-summary-text">
          <Skeleton width="min(22rem, 70%)" height={12} />
        </div>
        <Skeleton className="skeleton--button" width={112} />
      </div>
    );
  }
  return (
    <div className="trip-summary" data-testid="trip-summary">
      <p className="trip-summary-text" data-testid="trip-summary-text">
        <span className="sr-only">Your trip: </span>
        {tripSummaryText(request)}
      </p>
      <button
        type="button"
        className="toolbar-button"
        onClick={onEdit}
        aria-controls="trip-form-body"
        data-testid="edit-trip-button"
      >
        <EditIcon size={18} />
        Edit trip
      </button>
    </div>
  );
}
