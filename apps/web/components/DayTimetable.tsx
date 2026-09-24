"use client";

import { type Ref, useEffect, useRef } from "react";
import { clockDateTime } from "../lib/format";
import { photoForPlace } from "../lib/placePhotos";
import type { DayView } from "../lib/timetable";
import { ClockText } from "./Clock";
import { StopRow } from "./StopRow";
import { WarningChips } from "./WarningChip";

// One day as a departure board: a header (date, base, what the day holds, day-level notes), the
// transfer from the previous base as the first timed row when there is one, and an ordered list
// of stops with the travel legs between them. The list is also the text equivalent of the map.

/** How many stops load their photo at once; the rest load as they scroll near. */
const EAGER_PHOTOS = 3;

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
  // Each stop's times at the last render, by place. A stop whose times differ from them was
  // moved by an edit, and only its times flip; a new day has no stops in common, so nothing does.
  const lastTimes = useRef(new Map<string, string>());
  const timesOf = (start: number, end: number) => `${start}-${end}`;
  useEffect(() => {
    lastTimes.current = new Map(
      view.rows.map((row) => [row.stop.placeId, timesOf(row.stop.start, row.stop.end)]),
    );
  });
  return (
    <section aria-labelledby={headingId} data-testid="day-timetable" data-day={view.index + 1}>
      <header className="day-header">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="day-heading t-day">
          {view.heading}
        </h2>
        <p className="day-subtitle">
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
        {view.rows.map((row) => {
          const before = lastTimes.current.get(row.stop.placeId);
          const timesChanged =
            !animate && before !== undefined && before !== timesOf(row.stop.start, row.stop.end);
          return (
            <StopRow
              key={row.stop.placeId}
              row={row}
              dayIndex={view.index}
              date={view.day.date}
              isLast={row.index === count - 1}
              dayStopCount={count}
              changed={changedStop === row.index}
              timesChanged={timesChanged}
              photo={row.place ? photoForPlace(row.place) : null}
              eagerPhoto={row.index < EAGER_PHOTOS}
              onSwap={() => onSwap(row.index)}
              onRemove={() => onRemove(row.index)}
              onMove={(direction) => onMove(row.index, direction)}
            />
          );
        })}
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
