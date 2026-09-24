// The plan pane before there is a plan: loading places, planning, and the empty state.

export function LoadingPlaces() {
  return (
    <p className="text-base text-muted" role="status" data-testid="loading-places">
      Loading places
    </p>
  );
}

/** Shown while the plan request is in flight. The live region announces the same status. */
export function PlanningState() {
  return (
    <div className="planning" data-testid="planning-state">
      <p className="text-h2 font-semibold text-fg">Planning your trip</p>
      <p className="mt-2 max-w-prose text-base text-muted">
        Choosing places, then checking every stop against opening hours and travel time.
      </p>
      <ol className="planning-rules" aria-hidden="true">
        <li />
        <li />
        <li />
        <li />
      </ol>
    </div>
  );
}

/** Wide screens only: on phones the form itself is the first screen. */
export function EmptyPlan() {
  return (
    <div className="empty-plan" data-testid="empty-plan">
      <p className="text-h2 font-semibold leading-tight text-fg">
        Your three days will appear here as a timetable.
      </p>
      <p className="mt-3 max-w-prose text-base text-muted">
        Each day lists its stops with times, the travel between them, and a map. You can swap,
        remove, or reorder any stop, and every change is checked against opening hours again.
      </p>
    </div>
  );
}
