"use client";

import type { TripRequest } from "@italy/planner";
import type { ReactNode, Ref } from "react";
import type { TripFormValues } from "../lib/tripForm";
import type { TripDataState } from "../lib/useTripData";
import { BackIcon } from "./icons";
import { TripForm } from "./TripForm";
import { TripSummary } from "./TripSummary";

// The trip settings. Before any plan, the form is the page (one calm column). Once a plan is on
// screen or on its way, the form folds into the one-line trip summary with "Edit trip"; opening
// it shows a way back to the plan and a heading that takes focus. The form stays mounted while
// folded, so what the traveler typed and whether "More options" was open survive the fold.

export type PageView = "compose" | "plan";

interface TripPaneProps {
  view: PageView;
  formOpen: boolean;
  hasPlan: boolean;
  summaryRequest: TripRequest | null;
  onEdit: () => void;
  onBack: () => void;
  headingRef: Ref<HTMLHeadingElement>;
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
  const { view, formOpen, dataState, form } = props;
  const folded = view === "plan" && !formOpen;
  return (
    <section id="trip-form-pane" className="form-pane" aria-label="Trip settings">
      {folded ? <TripSummary request={props.summaryRequest} onEdit={props.onEdit} /> : null}
      <div id="trip-form-body" className="form-pane-body" hidden={folded}>
        {view === "plan" ? (
          <div className="form-return" data-testid="form-return">
            <button
              type="button"
              className="toolbar-button"
              onClick={props.onBack}
              data-testid="back-to-plan"
            >
              <BackIcon size={18} />
              Back to plan
            </button>
            <h2
              ref={props.headingRef}
              tabIndex={-1}
              className="mt-3 text-xl font-semibold text-fg outline-none"
              data-testid="form-heading"
            >
              Edit your trip
            </h2>
            {props.hasPlan ? (
              <p className="mt-1 text-sm text-muted">
                Your current plan stays until you plan again.
              </p>
            ) : null}
          </div>
        ) : null}
        {props.notice}
        <TripForm
          key={form.key}
          options={dataState.status === "ready" ? dataState.data.options : null}
          dataStatus={dataState.status}
          onRetryData={props.onRetryData}
          initialValues={form.values}
          planning={props.planning}
          slow={props.slow}
          onSubmit={props.onSubmit}
        />
        {props.error}
      </div>
    </section>
  );
}
