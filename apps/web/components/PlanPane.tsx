"use client";

import type { ReactNode } from "react";
import type { TripDataState } from "../lib/useTripData";
import { BaseLine } from "./BaseLine";
import { DataNotesPanel } from "./DataNotesPanel";
import { ErrorState } from "./ErrorState";
import { PlanSkeleton, type SkeletonReason } from "./skeleton/PlanSkeleton";
import { Skeleton } from "./skeleton/Skeleton";

// The plan area and the page's header and footer. The plan area shows the plan, or its skeleton
// while a plan is on its way (aria-busy is set here, on the region that waits), or, in the rare
// case where a plan arrived but the places never did, a way to load them again. A failed request
// keeps the previous plan and puts its message above it.

export type PlanContent = "skeleton" | "plan" | "unavailable";

export const PLACES_MISSING =
  "Your plan is ready, but the place details did not load, so it cannot be shown yet.";

export const TAGLINE = "Three days planned around real opening hours and travel time.";

interface PlanPaneProps {
  content: PlanContent;
  reason: SkeletonReason; // what the skeleton is waiting for
  slow: boolean;
  notice: ReactNode;
  error: ReactNode;
  onRetryData: () => void;
  children: ReactNode; // the plan, rendered when content is "plan"
}

export function PlanPane(props: PlanPaneProps) {
  const { content, reason, slow, notice, error, onRetryData, children } = props;
  return (
    <div
      id="plan"
      className="plan-pane"
      tabIndex={-1}
      aria-busy={content === "skeleton"}
      data-testid="plan-pane"
    >
      {notice}
      {error}
      {content === "skeleton" ? (
        <PlanSkeleton reason={reason} slow={slow} />
      ) : content === "unavailable" ? (
        <ErrorState message={PLACES_MISSING} onRetry={onRetryData} />
      ) : (
        children
      )}
    </div>
  );
}

/**
 * The title, and before any plan the one line that says what the page does and the line
 * diagram of the five bases the trip is planned from.
 */
export function AppHeader({ tagline }: { tagline: boolean }) {
  return (
    <header className="app-header">
      <h1 className="app-title">3 Days in Italy</h1>
      {tagline ? (
        <>
          <p className="app-tagline" data-testid="app-tagline">
            {TAGLINE}
          </p>
          <BaseLine />
        </>
      ) : null}
    </header>
  );
}

/** The foot of the page: "About this data" as a quiet link, a skeleton of it while it loads. */
export function AppFooter({ dataState }: { dataState: TripDataState }) {
  const loading = dataState.status === "loading";
  return (
    <footer className="app-footer" aria-busy={loading ? true : undefined}>
      {dataState.status === "ready" ? (
        <DataNotesPanel summary={dataState.data.summary} />
      ) : loading ? (
        <div className="data-notes-link" aria-hidden="true">
          <Skeleton width={112} height={12} testId="data-notes-skeleton" />
        </div>
      ) : null}
    </footer>
  );
}
