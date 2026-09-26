import { TRIP_DAYS } from "@italy/planner";
import { SLOW_PLAN_TEXT } from "../../lib/usePlanTrip";
import { Skeleton } from "./Skeleton";

// The plan's shape while it is on its way: the toolbar row (with the status in words where the
// source badge will be), a line where the plan's summary goes, day tabs, the day heading, stop
// rows with times in the gutter and dotted travel connectors, and the map. It uses the plan's
// own layout classes (plan-toolbar, day-tabs, day-panel, timetable-grid, map-frame), so each
// block sits where the real one will and the plan replaces it without a jump.

/** Stop rows drawn: a balanced day has five visits plus lunch and dinner. */
export const SKELETON_ROWS = 6;

// Fixed widths, so the static HTML and the browser's first render match.
const LEG_WIDTHS = ["42%", "30%", "36%", "26%", "40%", "32%"] as const;
const TITLE_WIDTHS = ["58%", "46%", "64%", "40%", "52%", "48%"] as const;
const SUBTITLE_WIDTHS = ["34%", "40%", "28%", "36%", "30%", "38%"] as const;

/** "Day 1", "Day 2", ...: one skeleton tab per trip day, keyed by its name. */
function tripDays(): string[] {
  return Array.from({ length: TRIP_DAYS }, (_, index) => `Day ${index + 1}`);
}

/** What the plan area is waiting for: a new plan, or a shared or saved one being opened. */
export type SkeletonReason = "planning" | "opening";

const STATUS: Record<SkeletonReason, { title: string; detail: string }> = {
  planning: {
    title: "Planning your trip",
    detail: "Choosing places, then checking every stop against opening hours and travel time.",
  },
  opening: {
    title: "Opening your plan",
    detail: "Loading the places to check it against current opening hours.",
  },
};

interface PlanSkeletonProps {
  reason: SkeletonReason;
  slow: boolean;
}

export function PlanSkeleton({ reason, slow }: PlanSkeletonProps) {
  const status = STATUS[reason];
  return (
    <div className="plan plan-skeleton" data-testid="planning-state">
      <div className="plan-toolbar">
        <p className="plan-skeleton-status">
          <span className="flap-spinner" aria-hidden="true" />
          {status.title}
        </p>
      </div>
      {/* Decision: after SLOW_PLAN_MS the honest line takes the explanation's place instead of
          adding a line, so nothing below it moves while the traveler waits. */}
      <p
        className="plan-skeleton-detail mt-2 max-w-prose text-base"
        data-testid={slow ? "planning-slow" : "planning-detail"}
      >
        {slow ? SLOW_PLAN_TEXT : status.detail}
      </p>
      <div className="day-tabs" aria-hidden="true" data-testid="skeleton-day-tabs">
        {tripDays().map((day) => (
          <div key={day} className="day-tab skeleton-tab">
            <Skeleton width={52} height={14} />
            <Skeleton width={96} height={10} />
          </div>
        ))}
      </div>
      <div className="day-panel pt-4" aria-hidden="true">
        <div>
          <div className="skeleton-day-header">
            <Skeleton className="skeleton--heading" width="56%" />
            <Skeleton width="42%" height={12} />
          </div>
          <ol className="timetable" data-testid="skeleton-rows">
            {LEG_WIDTHS.slice(0, SKELETON_ROWS).map((legWidth, index) => (
              <SkeletonStopRow key={legWidth} index={index} legWidth={legWidth} />
            ))}
          </ol>
        </div>
        <div className="day-map" data-testid="map-skeleton-frame">
          <div className="map-frame">
            <Skeleton className="skeleton--fill" testId="map-skeleton" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The rows of a day's board while that day alone is planned again (DayTimetable): as many as the
 * day had, within a few, so the board keeps about its height.
 */
export function DayRowsSkeleton({ rows }: { rows: number }) {
  const count = Math.min(Math.max(rows, 3), 7);
  return (
    <ol className="timetable" aria-hidden="true" data-testid="day-skeleton-rows">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonStopRow
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of identical placeholders.
          key={index}
          index={index % LEG_WIDTHS.length}
          legWidth={LEG_WIDTHS[index % LEG_WIDTHS.length] as string}
        />
      ))}
    </ol>
  );
}

function SkeletonStopRow({ index, legWidth }: { index: number; legWidth: string }) {
  return (
    <li className="skeleton-row">
      <div className="timetable-grid">
        <div className="leg-line" />
        <div className="skeleton-leg-text">
          <Skeleton width={legWidth} height={10} />
        </div>
      </div>
      <div className="timetable-grid">
        <div className="skeleton-times">
          <Skeleton width={44} height={14} />
          <Skeleton width={36} height={10} />
        </div>
        <div className="stop-body skeleton-body">
          <Skeleton className="skeleton--title" width={TITLE_WIDTHS[index]} />
          <Skeleton width={SUBTITLE_WIDTHS[index]} height={10} />
          <Skeleton width="24%" height={10} />
          <div className="skeleton-actions">
            <Skeleton width={64} height={14} />
            <Skeleton width={76} height={14} />
            <Skeleton width={18} height={14} />
            <Skeleton width={18} height={14} />
          </div>
        </div>
      </div>
    </li>
  );
}
