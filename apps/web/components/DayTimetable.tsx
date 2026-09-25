"use client";

import type { Place } from "@italy/planner";
import { type Ref, useCallback, useEffect, useMemo, useRef } from "react";
import { clockDateTime } from "../lib/format";
import { photoForPlace } from "../lib/placePhotos";
import { type DayView, dayTimes, movedStops, thumbnailRows } from "../lib/timetable";
import { type StopDetailsControl, type StopRef, useStopDetails } from "../lib/useStopDetails";
import { ClockText } from "./Clock";
import { StopDetailsSheet } from "./StopDetailsSheet";
import { StopRow } from "./StopRow";
import { WarningChips } from "./WarningChip";

// One day as a departure board: a header (date, base, what the day holds, day-level notes), the
// transfer from the previous base as the first timed row when there is one, and an ordered list
// of stops with the travel legs between them. The list is also the text equivalent of the map.
// One details sheet serves the day: a stop's photo or Details button opens it on that stop. The
// plan (PlanView) owns that sheet and shares it with the day's map; on its own the board keeps one.
// Closed on a stop the traveler stepped to in it, focus comes to that stop's Details here.

/** Thumbnails on stops before this index load at once; the rest load as they scroll near. */
const EAGER_PHOTOS = 3;

/**
 * The Details button of this stop on the board, brought into view: where focus lands when the
 * details sheet closes on a stop the traveler stepped to (useStopDetails).
 */
export function detailsButtonFor(list: HTMLElement | null, stop: StopRef): HTMLElement | null {
  const items = [...(list?.children ?? [])].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && "placeId" in child.dataset,
  );
  const at = items[stop.index];
  const item =
    at?.dataset.placeId === stop.placeId
      ? at
      : items.find((child) => child.dataset.placeId === stop.placeId);
  const button = item?.querySelector<HTMLElement>(".stop-action--details") ?? null;
  if (button) bringIntoView(button);
  return button;
}

/** How far down the page an element is laid out, whatever transform its ancestors are under. */
function pageTop(element: HTMLElement): number {
  let top = 0;
  for (let node: Element | null = element; node instanceof HTMLElement; node = node.offsetParent) {
    top += node.offsetTop;
  }
  return top;
}

/**
 * Scrolls an element to the middle of the screen when it is not on it, clear of the pinned day
 * tabs and the toast (the page's scroll padding). At once: the sheet is leaving over the page, so
 * the board is already in place as it clears.
 *
 * Decision: measured as laid out, not as drawn. Behind a phone sheet the page is scaled back
 * around the top of the screen (sheet.css), which draws every box closer to that top than it
 * will be; the drawn box would put a stop just under the screen on it, and scroll one to the
 * middle of the scaled page instead of the page the traveler returns to.
 */
function bringIntoView(element: HTMLElement): void {
  const style = getComputedStyle(document.documentElement);
  const top = Number.parseFloat(style.scrollPaddingTop) || 0;
  const bottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
  const onScreen = pageTop(element) - window.scrollY;
  const height = element.offsetHeight;
  if (onScreen >= top && onScreen + height <= window.innerHeight - bottom) return;
  const middle = (top + window.innerHeight - bottom) / 2;
  window.scrollTo({ top: window.scrollY + onScreen + height / 2 - middle, behavior: "instant" });
  // The page comes back from its scale around the top of what is on screen now, so it grows in
  // place instead of sliding by a share of the distance just scrolled.
  document.documentElement.style.setProperty("--recede-top", `${window.scrollY}px`);
}

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
  details?: StopDetailsControl; // the plan's details sheet, which the map opens too
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
  // The details sheet: the plan's when it passes one, so the map opens the same sheet;
  // otherwise the board's own (a board on its own, as in the tests).
  const own = useStopDetails(view.rows);
  const details = props.details ?? own.control;
  const list = useRef<HTMLOListElement>(null);
  const findDetails = useCallback((stop: StopRef) => detailsButtonFor(list.current, stop), []);
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
        ref={list}
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
              detailsId={details.id}
              detailsOpen={details.openIndex === row.index}
              onDetails={(opener) =>
                details.open({ index: row.index, placeId: row.stop.placeId }, opener, findDetails)
              }
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
      {props.details ? null : <StopDetailsSheet {...own.sheet} date={view.day.date} />}
    </section>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
