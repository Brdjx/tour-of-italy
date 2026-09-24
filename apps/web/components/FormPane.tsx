"use client";

import type { TripRequest } from "@italy/planner";
import type { ReactNode, Ref } from "react";
import { describeApiError } from "../lib/apiError";
import type { TripFormValues } from "../lib/tripForm";
import type { TripDataState } from "../lib/useTripData";
import { ErrorState } from "./ErrorState";
import { BackIcon } from "./icons";
import { LoadingPlaces } from "./PlanStates";
import { TripForm } from "./TripForm";

// The trip settings pane: the form once the places are loaded, their loading or error state
// before that, and a note (such as a damaged shared link) at the top where phones see it first.
// When the form is reopened over a plan on a phone or tablet, it starts with a way back to the
// plan and a heading that takes focus.

interface FormPaneProps {
  dataState: TripDataState;
  onRetryData: () => void;
  form: { key: number; values: TripFormValues };
  planning: boolean;
  onSubmit: (request: TripRequest) => void;
  reopened: boolean; // the form is open over an existing plan (below 1024 px)
  onBack: () => void;
  headingRef: Ref<HTMLHeadingElement>;
  notice: ReactNode;
}

export function FormPane(props: FormPaneProps) {
  const { dataState, form, planning, reopened } = props;
  return (
    <section id="trip-form-pane" className="form-pane" aria-label="Trip settings">
      {reopened ? (
        <div className="mb-5 lg:hidden" data-testid="form-return">
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
          <p className="mt-1 text-sm text-muted">Your current plan stays until you plan again.</p>
        </div>
      ) : null}
      {props.notice}
      <p className="mb-4 max-w-prose text-base text-fg">
        Pick your dates and interests to build a 3-day plan.
      </p>
      {dataState.status === "ready" ? (
        <TripForm
          key={form.key}
          options={dataState.data.options}
          initialValues={form.values}
          planning={planning}
          onSubmit={props.onSubmit}
        />
      ) : dataState.status === "error" ? (
        <ErrorState message={describeApiError(dataState.error)} onRetry={props.onRetryData} />
      ) : (
        <LoadingPlaces />
      )}
    </section>
  );
}
