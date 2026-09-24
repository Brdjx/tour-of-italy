import { formatDuration } from "../lib/format";
import type { LegView } from "../lib/timetable";

// The dotted connector between two stops, labelled with the travel time and mode, plus any free
// time before the next stop opens. It sits in the timetable's time gutter like a railway sheet.

export function TravelLeg({ leg }: { leg: LegView }) {
  return (
    <div className="timetable-grid" data-testid="travel-leg">
      <div className="leg-line" aria-hidden="true" />
      <p className="py-1.5 text-sm text-muted">
        {leg.text}
        {leg.freeMin > 0 ? `, then ${formatDuration(leg.freeMin)} free` : null}
      </p>
    </div>
  );
}
