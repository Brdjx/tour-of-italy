"use client";

import type { ReactNode, Ref } from "react";
import type { TripDataState } from "../lib/useTripData";
import { BaseLine } from "./BaseLine";
import { DataNotesPanel } from "./DataNotesPanel";
import { ErrorState } from "./ErrorState";
import { FlagMark } from "./FlagMark";
import { PlanSkeleton, type SkeletonReason } from "./skeleton/PlanSkeleton";
import { Skeleton } from "./skeleton/Skeleton";

// The plan area and the page's header and footer. The plan area shows the plan, or its skeleton
// while a plan is on its way (aria-busy is set here, on the region that waits), or, in the rare
// case where a plan arrived but the places never did, a way to load them again. A failed request
// keeps the previous plan and puts its message above it. The header is the first screen's
// title; the plan view has no bar at the top, its trip header (TripSummary) opens the page.

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
 * Before any plan: the title led by the flag mark, the one line that says what the page does,
 * and the line diagram of the five bases the trip is planned from. The title takes focus after
 * "Start a new trip".
 */
export function AppHeader({ titleRef }: { titleRef?: Ref<HTMLHeadingElement> }) {
  return (
    <header className="app-header">
      <h1 ref={titleRef} tabIndex={-1} className="app-title outline-none">
        <FlagMark />3 Days in Italy
      </h1>
      <p className="app-tagline" data-testid="app-tagline">
        {TAGLINE}
      </p>
      <BaseLine />
    </header>
  );
}

/**
 * The foot of the page: "About this data" as a quiet link that opens the data notes over the
 * page, a skeleton of it while the data loads.
 */
export function AppFooter({ dataState }: { dataState: TripDataState }) {
  const loading = dataState.status === "loading";
  return (
    <footer className="app-footer" aria-busy={loading ? true : undefined}>
      {dataState.status === "ready" ? (
        <DataNotesPanel data={dataState.data} />
      ) : loading ? (
        <div className="data-notes-link" aria-hidden="true">
          <Skeleton width={112} height={12} testId="data-notes-skeleton" />
        </div>
      ) : null}
    </footer>
  );
}
