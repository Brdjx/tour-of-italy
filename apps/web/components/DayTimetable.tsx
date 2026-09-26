"use client";

import type { Place } from "@italy/planner";
import { type Ref, useCallback, useEffect, useMemo, useRef } from "react";
import { type DayMade, dayClaim } from "../lib/dayCity";
import { clockDateTime } from "../lib/format";
import { photoForPlace } from "../lib/placePhotos";
import { type DayView, dayTimes, movedStops, thumbnailRows } from "../lib/timetable";
import { type StopDetailsControl, type StopRef, useStopDetails } from "../lib/useStopDetails";
import { ClockText } from "./Clock";
import { ChevronIcon } from "./icons";
import { ROUTE_SHEET_ID } from "./RouteSheet";
import { SourceMark } from "./SourceBadge";
import { StopDetailsSheet } from "./StopDetailsSheet";
import { StopRow } from "./StopRow";
import { DayRowsSkeleton } from "./skeleton/PlanSkeleton";
import { WarningChips } from "./WarningChip";

// One day as a departure board: a header (date, base, what the day holds, day-level notes), the
// transfer from the previous base as the first timed row when there is one, and an ordered list
// of stops with the travel legs between them. The list is also the text equivalent of the map.
// One details sheet serves the day: a stop's photo or Details button opens it on that stop. The
// plan (PlanView) owns that sheet and shares it with the day's map; on its own the board keeps one.
// Closed on a stop the traveler stepped to in it, focus comes to that stop's Details here.
// The city in "Day 2 in Rome" is a quiet pill that opens the route sheet on that day's cities
// (RouteSheet). While the day is planned again, or waits its turn in a route, the line says so
// and the rows are a skeleton; while other days are planned, editing waits and one line says so;
// a day planned again says how under its line, in the source line's words. A day that starts
// with travel says on its transfer row what the travel leaves of it.

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

/** The city pill on the day's heading line. */
export interface DayCityControl {
  onOpen: () => void;
  open: boolean; // the route sheet is open on this day
  disabled: boolean; // days are being planned again
}

/** The day while it is planned again, or waits its turn in a route. */
export interface DayPlanning {
  text: string; // "Planning day 2 in Florence (1 of 2)"
  slow: string | null; // the line that says it is still working, after a while
  waiting: boolean; // a later day of the route, not yet asked for
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
  city?: DayCityControl; // without it the city is plain text
  planning?: DayPlanning | null; // the day is being planned again
  locked?: string | null; // why editing waits, while other days are planned again
  made?: DayMade | null; // how the day was planned again, when it was
}

export function DayTimetable(props: DayTimetableProps) {
  const { view, animate, changedStop, onSwap, onRemove, onMove, headingRef } = props;
  const headingId = `day-heading-${view.index}`;
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
  const planning = props.planning ?? null;
  const locked = props.locked ?? null;
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={planning ? true : undefined}
      data-testid="day-timetable"
      data-day={view.index + 1}
      data-planning={planning ? "true" : undefined}
    >
      <header className="day-header">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="day-heading t-day">
          {view.heading}
        </h2>
        {planning ? (
          <DayPlanningLine planning={planning} />
        ) : (
          <>
            <p className="day-subtitle" data-testid="day-subtitle">
              Day {view.index + 1} in{" "}
              {props.city ? (
                <>
                  <CityPill control={props.city} name={view.anchorName} day={view.index} />
                  {/* Decision: no comma after the pill on screen, where its chevron already
                      ends the city; a screen reader still hears the sentence with one. */}
                  <span className="text-muted day-stops">
                    <span className="sr-only">, </span>
                    {view.stopsText}
                  </span>
                </>
              ) : (
                <>
                  {view.anchorName}
                  <span className="text-muted">, {view.stopsText}</span>
                </>
              )}
            </p>
            {props.made ? <DaySource made={props.made} /> : null}
            {locked ? (
              <p className="day-locked" data-testid="day-locked">
                {locked}
              </p>
            ) : null}
            <WarningChips chips={view.dayChips} />
          </>
        )}
      </header>
      {planning ? (
        <DayRowsSkeleton rows={view.rows.length} />
      ) : (
        <DayRows
          view={view}
          times={{ animate, moved }}
          changedStop={changedStop}
          thumbnails={thumbnails}
          details={details}
          list={list}
          findDetails={findDetails}
          locked={locked !== null}
          onSwap={onSwap}
          onRemove={onRemove}
          onMove={onMove}
        />
      )}
      {props.details ? null : <StopDetailsSheet {...own.sheet} date={view.day.date} />}
    </section>
  );
}

/** "Rome" and an onward chevron: the city, which opens the route sheet on the day's cities. */
function CityPill(props: { control: DayCityControl; name: string; day: number }) {
  const { control, name } = props;
  return (
    <button
      type="button"
      id={`day-city-${props.day}`}
      className="city-pill"
      onClick={control.disabled ? undefined : control.onOpen}
      aria-haspopup="dialog"
      aria-expanded={control.open}
      aria-controls={ROUTE_SHEET_ID}
      aria-disabled={control.disabled || undefined}
      data-testid="city-button"
    >
      {name}
      {/* Decision: the name first, then these words, so voice control finds it by what it shows
          ("Rome") and a screen reader hears what it does. */}
      <span className="sr-only">, change city</span>
      <ChevronIcon size={16} className="city-pill-chevron" />
    </button>
  );
}

/** The day's heading line while the day is planned again, with the board's busy flap. */
function DayPlanningLine({ planning }: { planning: DayPlanning }) {
  return (
    <>
      <p
        className="day-subtitle day-planning"
        data-testid="day-planning"
        data-waiting={planning.waiting ? "true" : undefined}
      >
        <span
          className={planning.waiting ? "flap-spinner flap-spinner--still" : "flap-spinner"}
          aria-hidden="true"
        />
        {planning.text}
      </p>
      {planning.slow ? (
        <p className="day-planning-slow" data-testid="day-planning-slow">
          {planning.slow}
        </p>
      ) : null}
    </>
  );
}

/** "Planned again with AI": how the day was planned again, with the source line's mark. */
function DaySource({ made }: { made: DayMade }) {
  const { claim, ai } = dayClaim(made);
  return (
    <p className="day-source" data-testid="day-source" data-marker={ai ? "ai" : "rules"}>
      <SourceMark marker={ai ? "ai" : "rules"} />
      <span>{claim}</span>
    </p>
  );
}

interface DayRowsProps {
  view: DayView;
  times: { animate: boolean; moved: Set<string> };
  changedStop: number | null;
  thumbnails: Set<number>;
  details: StopDetailsControl;
  list: Ref<HTMLOListElement>;
  findDetails: (stop: StopRef) => HTMLElement | null;
  locked: boolean;
  onSwap: (stop: number) => void;
  onRemove: (stop: number) => void;
  onMove: (stop: number, direction: "up" | "down") => void;
}

/** The transfer, the stops with their legs, and the way back: the board itself. */
function DayRows(props: DayRowsProps) {
  const { view, times, changedStop, thumbnails, details, list, findDetails } = props;
  const { onSwap, onRemove, onMove } = props;
  const count = view.rows.length;
  const transfer = view.transfer;
  const animate = times.animate;
  return (
    <>
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
          <div className="py-0.5">
            <p className="text-base text-fg">
              <span className="sr-only">Transfer: </span>
              {capitalize(transfer.text)}
            </p>
            {transfer.left ? (
              <p className="transfer-left" data-testid="transfer-left">
                {transfer.left}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <ol
        ref={list}
        className={`timetable${animate ? " timetable--draw" : ""}`}
        aria-label="Stops in visiting order"
      >
        {view.rows.map((row) => {
          const timesChanged = times.moved.has(row.stop.placeId);
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
              locked={props.locked}
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
    </>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
