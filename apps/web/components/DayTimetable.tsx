"use client";

import type { Place } from "@italy/planner";
import { type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import { clockDateTime } from "../lib/format";
import { photoForPlace } from "../lib/placePhotos";
import { type DayView, dayTimes, movedStops, thumbnailRows } from "../lib/timetable";
import { ClockText } from "./Clock";
import { StopDetailsSheet } from "./StopDetailsSheet";
import { StopRow } from "./StopRow";
import { WarningChips } from "./WarningChip";

// One day as a departure board: a header (date, base, what the day holds, day-level notes), the
// transfer from the previous base as the first timed row when there is one, and an ordered list
// of stops with the travel legs between them. The list is also the text equivalent of the map.
// One details sheet serves the day: a stop's photo or Details button opens it on that stop.

/** Thumbnails on stops before this index load at once; the rest load as they scroll near. */
const EAGER_PHOTOS = 3;

/** A photo of the place itself, not a city or general stand-in, can be a highlight. */
function hasOwnPhoto(place: Place): boolean {
  return photoForPlace(place)?.kind === "place";
}

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
  // A few highlights, not a photo per row: the day's best-rated stops with a photo of their own.
  const thumbnails = useMemo(() => thumbnailRows(view.rows, hasOwnPhoto), [view.rows]);
  // Each stop's times as last shown. A stop whose times differ from them was moved by an edit,
  // and only its times flip; a new day has no stops in common, so nothing does.
  // Decision: worked out once per new set of times, not once per render. A re-render that
  // rebuilds the same day (a status message, a check that finishes) used to clear the flip about
  // 90 ms into its 320 ms; now each flip keeps its element until it has played.
  const times = dayTimes(view.rows);
  const shownTimes = useRef("");
  const moved = useMemo(
    () => (animate ? new Set<string>() : movedStops(shownTimes.current, times)),
    [animate, times],
  );
  useEffect(() => {
    shownTimes.current = times;
  }, [times]);
  // The stop in the details sheet. Decision: kept after the sheet closes, so it leaves with its
  // content instead of emptying first; keyed by place, so a rebuilt view still finds it.
  const detailsId = useId();
  const [details, setDetails] = useState<{ placeId: string; open: boolean } | null>(null);
  const detailsOpener = useRef<HTMLElement | null>(null);
  const detailsRow = details
    ? (view.rows.find((row) => row.stop.placeId === details.placeId) ?? null)
    : null;
  const detailsOpen = details?.open === true && detailsRow !== null;
  // A stop that leaves the board while its sheet is open closes the sheet for good. Without
  // this the sheet would only look closed, and open again by itself if the place came back.
  useEffect(() => {
    if (details?.open && detailsRow === null) {
      setDetails((shown) => (shown ? { ...shown, open: false } : shown));
    }
  }, [details, detailsRow]);
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
          const timesChanged = moved.has(row.stop.placeId);
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
              thumbnail={thumbnails.has(row.index)}
              eagerPhoto={row.index < EAGER_PHOTOS}
              detailsId={detailsId}
              detailsOpen={detailsOpen && details?.placeId === row.stop.placeId}
              onDetails={(opener) => {
                detailsOpener.current = opener;
                setDetails({ placeId: row.stop.placeId, open: true });
              }}
              onSwap={() => onSwap(row.index)}
              onRemove={() => onRemove(row.index)}
              onMove={(direction) => onMove(row.index, direction)}
            />
          );
        })}
      </ol>
      {view.returnLeg ? (
        <div className="timetable-grid" data-testid="return-leg">
          <div className="leg-line leg-line--end" aria-hidden="true" />
          <p className="py-1.5 text-sm text-muted">{view.returnLeg}</p>
        </div>
      ) : null}
      <StopDetailsSheet
        id={detailsId}
        open={detailsOpen}
        row={detailsRow}
        date={view.day.date}
        onClose={() => setDetails((shown) => (shown ? { ...shown, open: false } : shown))}
        returnFocus={detailsOpener}
      />
    </section>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
