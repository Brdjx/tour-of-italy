"use client";

import type { TripRequest } from "@italy/planner";
import { type ReactNode, useRef } from "react";
import type { TripFormValues } from "../lib/tripForm";
import type { TripDataState } from "../lib/useTripData";
import { CloseIcon } from "./icons";
import { Sheet } from "./Sheet";
import { TripForm } from "./TripForm";

// The trip settings. Before any plan, the form is the page (one calm column). Once a plan is on
// screen or on its way, the form lives in the Edit trip sheet: "Edit trip" in the trip header
// (TripSummary) opens it over the page, with Plan my trip as its footer and a quiet way to start
// a new trip. The sheet stays mounted while closed, so what the traveler typed survives closing.

export type PageView = "compose" | "plan";

/** The id of the Edit trip sheet, which "Edit trip" controls. */
export const TRIP_SHEET_ID = "trip-form-body";

interface TripPaneProps {
  view: PageView;
  formOpen: boolean;
  hasPlan: boolean;
  onBack: () => void;
  onStartOver?: () => void; // "Start a new trip", offered while a plan is on screen
  notice: ReactNode; // a note (a damaged shared link) where the traveler looks first
  error: ReactNode; // a failed plan when there is no plan to keep on screen
  form: { key: number; values: TripFormValues };
  dataState: TripDataState;
  onRetryData: () => void;
  planning: boolean;
  slow: boolean;
  onSubmit: (request: TripRequest) => void;
}

export function TripPane(props: TripPaneProps) {
  const { view, dataState, form } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Decision: the form moves from the page into the sheet when the first plan is asked for, so
  // React mounts it again there; PlannerApp hands it the values that were sent.
  const tripForm = (
    <TripForm
      key={form.key}
      options={dataState.status === "ready" ? dataState.data.options : null}
      dataStatus={dataState.status}
      onRetryData={props.onRetryData}
      initialValues={form.values}
      planning={props.planning}
      slow={props.slow}
      onSubmit={props.onSubmit}
      beforeActions={
        view === "plan" && props.onStartOver ? <StartOver onStartOver={props.onStartOver} /> : null
      }
    />
  );

  if (view === "compose") {
    return (
      <section id="trip-form-pane" className="form-pane" aria-label="Trip settings">
        <div id={TRIP_SHEET_ID} className="form-pane-body">
          {props.notice}
          {tripForm}
          {props.error}
        </div>
      </section>
    );
  }

  return (
    <Sheet
      open={props.formOpen}
      onClose={props.onBack}
      id={TRIP_SHEET_ID}
      labelledBy="trip-sheet-title"
      size="tall"
      className="trip-sheet"
      testId="trip-sheet"
      initialFocus={headingRef}
      header={
        <>
          <h2
            id="trip-sheet-title"
            ref={headingRef}
            tabIndex={-1}
            className="form-sheet-title t-title outline-none"
            data-testid="form-heading"
          >
            Edit your trip
          </h2>
          <button
            type="button"
            className="pill pill--quiet pill--round form-sheet-close"
            onClick={props.onBack}
            aria-label="Back to plan"
            data-testid="back-to-plan"
          >
            <CloseIcon size={22} />
          </button>
        </>
      }
    >
      {props.hasPlan ? (
        <p className="form-sheet-lede" data-testid="form-return">
          Your current plan stays until you plan again.
        </p>
      ) : null}
      {props.notice}
      {tripForm}
      {props.error}
    </Sheet>
  );
}

/** "Start a new trip": quiet on purpose, below the form, never next to Plan my trip. */
function StartOver({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div className="start-over" data-testid="start-over">
      <button
        type="button"
        className="text-button"
        onClick={onStartOver}
        data-testid="start-over-button"
      >
        Start a new trip
      </button>
      <p className="field-hint mt-0">Clears this plan and your changes from this device.</p>
    </div>
  );
}
