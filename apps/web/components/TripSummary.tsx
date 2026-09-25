"use client";

import type { Itinerary, PrivateAiText, TripRequest } from "@italy/planner";
import type { PlanOrigin } from "../lib/itineraryReducer";
import type { FallbackCause } from "../lib/planRequest";
import type { SavedTrip } from "../lib/savedTrip";
import { tripDateRange, tripPaceText } from "../lib/tripSummary";
import { EditIcon, UndoIcon } from "./icons";
import { type SaveTrip, ShareLinkButton, ShareLinkField, useShareLink } from "./ShareButton";
import { SourceBadge } from "./SourceBadge";
import { Skeleton } from "./skeleton/Skeleton";
import { TRIP_SHEET_ID } from "./TripPane";

// The block that opens the plan view, in place of a navigation bar. The trip's dates are the
// page's heading, with the pace under them; Edit trip and Copy link sit on the right from 640 px,
// and on phones they share one row under the pace, each with its icon and words. Under it, one line says
// how the plan was made (its details open on tap), with Undo once there is an edit. While a plan
// is on its way, Edit trip and Copy link dim and do nothing until it arrives or fails, and the
// source line waits; while a shared or saved plan loads, the whole block is a skeleton.

export interface HeaderPlan {
  itinerary: Itinerary;
  origin: PlanOrigin;
  cause: FallbackCause | null;
  saved: SavedTrip | null; // the saved trip it was opened from
  errors: number; // error-level violations right now
  flaggedStops: number; // stops with one of them
  edited: boolean;
  privateText: PrivateAiText; // what a saved trip of it leaves out to keep the notes private
}

interface TripSummaryProps {
  request: TripRequest | null;
  onEdit: () => void;
  editing: boolean; // the Edit trip sheet is open
  planning: boolean; // a plan is on its way: Edit trip waits for it
  plan: HeaderPlan | null; // the plan on screen; null while one is on its way
  undoLabel: string | null;
  onUndo: () => void;
  onStatus: (message: string) => void;
  saveTrip?: SaveTrip; // POST /api/trips by default; injected in tests
}

// Decision: Edit trip and Copy link keep their words on phones. As round icon pills they were
// the page's main actions shown as glyphs to guess at; the finish review flagged it. Only Undo
// shortens there, and its hidden words stay its name for screen readers and voice control.
const WIDE_LABEL = "max-sm:sr-only";

// Decision: while a plan is on its way, Edit trip is aria-disabled rather than disabled. It stays
// in the tab order and keeps its name, so a keyboard or screen reader user finds it where it
// always is and hears that it is unavailable, and focus is never dropped to the page if it was
// on the button when planning began. A press does nothing (pointer-events are off too). Copy
// link waits the same way: with no plan on screen it has nothing to copy, and the link to the
// plan before would be stale.
export function TripSummary(props: TripSummaryProps) {
  const { request, plan, planning } = props;
  const share = useShareLink(plan?.itinerary ?? null, props.onStatus, {
    savedFrom: plan?.saved?.id ?? null,
    flagged: (plan?.errors ?? 0) > 0,
    flaggedStops: plan?.flaggedStops ?? 0,
    ...(plan ? { privateText: plan.privateText } : {}),
    ...(props.saveTrip ? { saveTrip: props.saveTrip } : {}),
  });
  if (!request) {
    return (
      <div className="trip-head" aria-hidden="true" data-testid="trip-summary-skeleton">
        <div className="trip-head-top">
          <div className="trip-head-text">
            <Skeleton className="trip-head-title-skeleton" width="min(15rem, 80%)" />
            <Skeleton className="trip-head-meta-skeleton" width="min(9rem, 50%)" />
          </div>
          <div className="trip-head-actions">
            <Skeleton className="skeleton--button head-pill-skeleton" />
            <Skeleton className="skeleton--button head-pill-skeleton" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <header className="trip-head" data-testid="trip-summary">
      <div className="trip-head-top">
        <div className="trip-head-text">
          <h1 className="trip-head-title t-title" data-testid="trip-summary-text">
            <span className="sr-only">Your trip: </span>
            {tripDateRange(request.startDate)}
          </h1>
          <p className="trip-head-meta" data-testid="trip-summary-meta">
            {tripPaceText(request)}
          </p>
        </div>
        <div className="trip-head-actions">
          <button
            type="button"
            className="head-pill"
            onClick={planning ? undefined : props.onEdit}
            aria-haspopup="dialog"
            aria-expanded={props.editing}
            aria-controls={TRIP_SHEET_ID}
            aria-disabled={planning || undefined}
            data-testid="edit-trip-button"
          >
            <EditIcon size={18} />
            <span>Edit trip</span>
          </button>
          <ShareLinkButton share={share} className="head-pill" disabled={!plan} />
        </div>
      </div>
      {plan ? (
        <div className="trip-head-status">
          <SourceBadge
            itinerary={plan.itinerary}
            origin={plan.origin}
            cause={plan.cause}
            saved={plan.saved}
            errors={plan.errors}
            edited={plan.edited}
          />
          {props.undoLabel ? <UndoPill label={props.undoLabel} onUndo={props.onUndo} /> : null}
        </div>
      ) : null}
      <ShareLinkField share={share} />
    </header>
  );
}

/** "Undo remove", shortened to "Undo" on phones; the full words stay its name. */
function UndoPill({ label, onUndo }: { label: string; onUndo: () => void }) {
  const [verb, ...rest] = label.split(" ");
  return (
    <button
      type="button"
      className="pill pill--quiet head-undo"
      onClick={onUndo}
      data-testid="undo-button"
    >
      <UndoIcon size={18} />
      <span>
        {verb} {rest.length > 0 ? <span className={WIDE_LABEL}>{rest.join(" ")}</span> : null}
      </span>
    </button>
  );
}
