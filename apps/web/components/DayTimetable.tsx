"use client";

import type { Ref } from "react";
import { clockDateTime } from "../lib/format";
import type { DayView } from "../lib/timetable";
import { ClockText } from "./Clock";
import { StopRow } from "./StopRow";
import { WarningChips } from "./WarningChip";

// One day as a timetable: a header (date, base, what the day holds, day-level notes), the
// transfer from the previous base as the first timed row when there is one, and an ordered list
// of stops with the travel legs between them. The list is also the text equivalent of the map.

export interface DayTimetableProps {
  view: DayView;
  animate: boolean; // draw the rows in once, only right after a new plan arrives
  changedStop: number | null;
  onSwap: (stop: number) => void;
  onRemove: (stop: number) => void;
  onMove: (stop: number, direction: "up" | "down") => void;
  headingRef?: Ref<HTMLHeadingElement>; // focused after a plan arrives or a stop is removed
}

export function DayTimetable(props: DayTimetableProps) {
  const { view, animate, changedStop, onSwap, onRemove, onMove, headingRef } = props;
  const headingId = `day-heading-${view.index}`;
  const count = view.rows.length;
  const transfer = view.transfer;
  return (
    <section aria-labelledby={headingId} data-testid="day-timetable" data-day={view.index + 1}>
      <header className="border-b border-line pb-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-h2 font-semibold leading-tight text-fg outline-none"
        >
          {view.heading}
        </h2>
        <p className="mt-1 text-base text-fg">
          Day {view.index + 1} in {view.anchorName}
          <span className="text-muted">, {view.stopsText}</span>
        </p>
        <WarningChips chips={view.dayChips} />
      </header>
      {transfer ? (
        <div className="timetable-grid transfer-row" data-testid="transfer-note">
          <p className="stop-times">
            <time dateTime={clockDateTime(view.day.date, transfer.depart)} className="block">
              <ClockText minutes={transfer.depart} />
            </time>
            <span className="sr-only"> to </span>
            <time
              dateTime={clockDateTime(view.day.date, transfer.arrive)}
              className="block text-sm text-muted"
            >
              <ClockText minutes={transfer.arrive} />
            </time>
          </p>
          <p className="py-0.5 text-base text-fg">
            <span className="sr-only">Transfer: </span>
            {capitalize(transfer.text)}
          </p>
        </div>
      ) : null}
      <ol
        className={`timetable${animate ? " timetable--draw" : ""}`}
        aria-label="Stops in visiting order"
      >
        {view.rows.map((row) => (
          <StopRow
            key={row.stop.placeId}
            row={row}
            dayIndex={view.index}
            date={view.day.date}
            isLast={row.index === count - 1}
            dayStopCount={count}
            changed={changedStop === row.index}
            onSwap={() => onSwap(row.index)}
            onRemove={() => onRemove(row.index)}
            onMove={(direction) => onMove(row.index, direction)}
          />
        ))}
      </ol>
      {view.returnLeg ? (
        <div className="timetable-grid" data-testid="return-leg">
          <div className="leg-line" aria-hidden="true" />
          <p className="py-1.5 text-sm text-muted">{view.returnLeg}</p>
        </div>
      ) : null}
    </section>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
