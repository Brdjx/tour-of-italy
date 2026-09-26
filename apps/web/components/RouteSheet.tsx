"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import type { CityRow, DayChoices, RouteRow, RouteView } from "../lib/dayRoute";
import type { RouteLevel } from "../lib/useDayRoute";
import { BackIcon, CheckIcon, ChevronIcon, CloseIcon, RefreshIcon } from "./icons";
import { Sheet } from "./Sheet";

// The route sheet (decision 16): a city for each day, from the city on any day's line. One sheet
// with two levels, a bottom sheet on phones and a centred panel from 768 px (Sheet). The route
// view lists the three days as a small board (the day and its date, then its city with the
// onward chevron), with the travel into each day on a dashed leg between them, and on each day
// the route changes: the city it replaces, what happens to it and its travel as facts. A day
// opens its own list of cities, the child level, inside the same sheet: the trip's city for the
// day first, with New ideas for this day; every city with how the day meets its neighbours and
// its places, then its travel and what else it plans again as warnings; and a city the planner
// refuses in place with its reason and the way out, never hidden. The sheet opens on the tapped
// day's cities, brought forward over the route, so changing one day is a city and then the
// route's one action. Back, and Escape, return to the route; Escape there closes. Closing without
// the action leaves the trip as it was.

export const ROUTE_SHEET_ID = "route-sheet";

// Decision: said once at the top of the route. Every day planned again, a new city's or not,
// takes only places the trip does not have yet, and travel is the traveler's to spend.
export const ROUTE_LEDE =
  "Choose a city for each day. Days that change are planned again with places your trip does not have yet, and travel between cities comes out of the day.";

interface RouteSheetProps {
  open: boolean;
  level: RouteLevel;
  day: number; // the day whose cities show, or showed last (0-based)
  moved: boolean; // the level changed since the sheet opened
  view: RouteView | null; // the route being set
  choices: DayChoices | null; // the cities for `day`
  dates: readonly string[]; // each day's long date ("Saturday 10 October")
  range: string; // the trip's dates ("Tue 6 Oct to Thu 8 Oct")
  said: { text: string | null; serial: number }; // the sheet's own live region
  onOpenDay: (day: number) => void;
  onBack: () => void;
  onChoose: (anchorId: string) => void;
  onIdeas: () => void;
  onReset: () => void;
  onConfirm: () => void;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}

export function RouteSheet(props: RouteSheetProps) {
  const { open, level, day, moved, view, choices } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const tallest = useRef(0);
  const shown = useRef<{ level: RouteLevel; day: number } | null>(null);

  // Focus moves with the level: to the heading of a day's cities, and back to that day's row in
  // the route. The sheet puts focus on the heading as it opens (Sheet).
  useLayoutEffect(() => {
    if (!open) {
      shown.current = null;
      return;
    }
    const before = shown.current;
    shown.current = { level, day };
    if (before === null || (before.level === level && before.day === day)) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-testid="route-day"][data-day="${day}"]`,
    );
    const target = level === "route" && row ? row : headingRef.current;
    target?.focus({ preventScroll: true });
  }, [open, level, day]);

  // Decision: the sheet keeps the tallest height it has had since it opened, so going between the
  // levels never shrinks it under the traveler's finger (the Steady Sheet Rule). It grows when a
  // level needs more, and starts again the next time it opens.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.style.minHeight = "";
    if (!open) {
      tallest.current = 0;
      return;
    }
    tallest.current = Math.max(tallest.current, body.offsetHeight);
    if (tallest.current > 0) body.style.minHeight = `${tallest.current}px`;
  });

  // Escape goes back one level before it closes the sheet.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || level !== "day" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    props.onBack();
  };

  const reset = () => {
    props.onReset();
    headingRef.current?.focus({ preventScroll: true });
  };

  const onDay = level === "day";
  const title = onDay ? `City for day ${day + 1}` : "Your route";
  const subtitle = onDay ? (props.dates[day] ?? "") : props.range;
  // The level slides in from the side it was reached from; the sheet's first level drops in.
  const entry = { "--from": onDay ? 1 : -1 } as CSSProperties;
  const footer =
    !onDay && view?.changed ? (
      <RouteActions view={view} onReset={reset} onConfirm={props.onConfirm} />
    ) : undefined;
  return (
    <Sheet
      open={open}
      onClose={props.onClose}
      id={ROUTE_SHEET_ID}
      labelledBy={titleId}
      size="fit"
      className="city-sheet route-sheet"
      testId="route-sheet"
      initialFocus={headingRef}
      returnFocus={props.returnFocus}
      onKeyDown={onKeyDown}
      header={
        <>
          <div className="route-head" data-level={level}>
            {onDay ? (
              <button
                type="button"
                className="pill pill--quiet pill--round route-back"
                onClick={props.onBack}
                aria-label="Back to your route"
                data-testid="route-back"
              >
                <BackIcon size={22} />
              </button>
            ) : null}
            <div
              key={`${level}-${day}`}
              className="details-sheet-heading route-heading"
              data-entry={moved ? "slide" : "open"}
              style={entry}
            >
              <h2
                id={titleId}
                ref={headingRef}
                tabIndex={-1}
                className="form-sheet-title t-title outline-none"
                data-testid="route-title"
              >
                {title}
              </h2>
              <p className="stop-subtitle">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            className="pill pill--quiet pill--round form-sheet-close"
            onClick={props.onClose}
            aria-label="Close"
            data-testid="route-close"
          >
            <CloseIcon size={22} />
          </button>
        </>
      }
      footer={footer}
    >
      <div ref={bodyRef} className="route-body" data-level={level}>
        {view === null ? null : (
          <div
            key={`${level}-${day}`}
            className="route-level"
            data-entry={moved ? "slide" : "open"}
            style={entry}
          >
            {onDay && choices ? (
              <DayCities choices={choices} onChoose={props.onChoose} onIdeas={props.onIdeas} />
            ) : (
              <RouteDays view={view} onOpenDay={props.onOpenDay} />
            )}
          </div>
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="route-said">
        {props.said.text ? <p key={props.said.serial}>{props.said.text}</p> : null}
      </div>
    </Sheet>
  );
}

/** The route: each day as a row of the small board, with the travel into it above it. */
function RouteDays({ view, onOpenDay }: { view: RouteView; onOpenDay: (day: number) => void }) {
  return (
    <div className="route-view" data-testid="route-view">
      <p className="city-lede">{ROUTE_LEDE}</p>
      <ol className="route-days" aria-label="Days">
        {view.rows.map((row, index) => (
          <li
            key={row.day}
            className="route-days-item"
            data-changed={row.was ? "true" : undefined}
            style={{ "--i": index } as CSSProperties}
          >
            {row.legIn ? (
              <p className="route-leg" data-testid="route-leg">
                <span className="route-leg-line" aria-hidden="true" />
                <span className="route-leg-text">{row.legIn}</span>
              </p>
            ) : null}
            <RouteDay row={row} onOpen={() => onOpenDay(row.day)} />
          </li>
        ))}
      </ol>
      {view.travel ? (
        <p className="route-travel" data-testid="route-travel">
          {view.travel}
        </p>
      ) : null}
    </div>
  );
}

/** One day of the route: a button named by the day, its date and its city, opening its cities. */
function RouteDay({ row, onOpen }: { row: RouteRow; onOpen: () => void }) {
  const factsId = useId();
  const hasFacts = row.note !== null || row.facts.length > 0 || row.refusal !== null;
  const was = row.was ? `, was ${row.was}` : "";
  return (
    <button
      type="button"
      className="route-day"
      onClick={onOpen}
      aria-label={`Day ${row.day + 1}, ${row.date}, ${row.name}${was}, choose city`}
      aria-describedby={hasFacts ? factsId : undefined}
      data-testid="route-day"
      data-day={row.day}
      data-anchor-id={row.anchorId}
      data-changed={row.was ? "true" : undefined}
      data-replan={row.replan ? "true" : undefined}
    >
      <span className="route-day-when">
        <span className="route-day-title">Day {row.day + 1}</span>
        <span className="route-day-date">{row.date}</span>
      </span>
      <span className="route-day-main">
        <span className="route-day-head">
          <span className="city-name t-tab">{row.name}</span>
          <ChevronIcon size={16} className="city-option-chevron" />
          {row.was ? <span className="route-was">was {row.was}</span> : null}
        </span>
        {hasFacts ? (
          <span id={factsId} className="route-day-facts" data-testid="route-day-facts">
            {row.note ? <span className="route-note">{row.note}</span> : null}
            {row.facts.map((fact) => (
              <span key={fact} className="city-warning">
                {fact}
              </span>
            ))}
            {row.refusal ? (
              <span className="route-refusal" data-testid="route-refusal">
                {row.refusal}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Reset, and the route's one action, named by what it plans. */
function RouteActions({
  view,
  onReset,
  onConfirm,
}: {
  view: RouteView;
  onReset: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="route-actions">
      <button
        type="button"
        className="pill pill--quiet route-reset"
        onClick={onReset}
        data-testid="route-reset"
      >
        Reset
      </button>
      <button
        type="button"
        className="pill pill--fill route-confirm"
        onClick={view.allowed ? onConfirm : undefined}
        aria-disabled={view.allowed ? undefined : true}
        data-testid="route-confirm"
      >
        {view.action}
      </button>
    </div>
  );
}

/** A day's cities: the trip's city first, with New ideas for this day. */
function DayCities({
  choices,
  onChoose,
  onIdeas,
}: {
  choices: DayChoices;
  onChoose: (anchorId: string) => void;
  onIdeas: () => void;
}) {
  return (
    <ul className="city-list" aria-label="Cities" data-testid="city-choices">
      {choices.rows.map((row, index) => (
        <li key={row.anchorId} style={{ "--i": index } as CSSProperties}>
          {row.chosen ? <ChosenCity row={row} /> : <CityOption row={row} onChoose={onChoose} />}
          {row.planned ? <NewIdeas ideas={choices.ideas} onIdeas={onIdeas} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The day's city in the route being set: marked, not pressable. */
function ChosenCity({ row }: { row: CityRow }) {
  return (
    <div
      className="city-option city-option--chosen"
      data-testid="city-current"
      data-anchor-id={row.anchorId}
    >
      <span className="city-option-head">
        <span className="city-name t-tab">{row.name}</span>
        <span className="city-now">
          <CheckIcon size={16} />
          {row.planned ? "This day" : "Chosen"}
        </span>
      </span>
      <CityFacts row={row} />
    </div>
  );
}

/**
 * Another city: one button, named by the city, with its line and warnings (or, when the planner
 * does not allow it, its reason) as the button's description. Only a city the day can take has
 * the chevron.
 */
function CityOption({ row, onChoose }: { row: CityRow; onChoose: (anchorId: string) => void }) {
  const nameId = useId();
  const factsId = useId();
  return (
    <button
      type="button"
      className="city-option"
      onClick={row.allowed ? () => onChoose(row.anchorId) : undefined}
      aria-disabled={row.allowed ? undefined : true}
      aria-labelledby={nameId}
      aria-describedby={factsId}
      data-testid="city-option"
      data-anchor-id={row.anchorId}
      data-allowed={row.allowed ? "true" : "false"}
    >
      <span className="city-option-head">
        <span id={nameId} className="city-name t-tab">
          {row.name}
        </span>
        {row.allowed ? <ChevronIcon size={16} className="city-option-chevron" /> : null}
        {row.planned ? <span className="city-planned">Planned now</span> : null}
      </span>
      <span id={factsId} className="city-facts">
        {row.allowed ? <CityFacts row={row} /> : <span className="city-reason">{row.reason}</span>}
      </span>
    </button>
  );
}

/** A city's line, then its warnings with the caution square. */
function CityFacts({ row }: { row: CityRow }) {
  return (
    <>
      <span className="city-line">{row.line}</span>
      {row.warnings.map((warning) => (
        <span key={warning} className="city-warning">
          {warning}
        </span>
      ))}
    </>
  );
}

/** New ideas for this day, under the trip's city for it, or why not now. */
function NewIdeas({ ideas, onIdeas }: { ideas: DayChoices["ideas"]; onIdeas: () => void }) {
  const reasonId = useId();
  return (
    <div className="city-ideas-wrap">
      <button
        type="button"
        className="pill pill--line city-ideas"
        onClick={ideas.allowed ? onIdeas : undefined}
        aria-disabled={ideas.allowed ? undefined : true}
        aria-describedby={ideas.allowed ? undefined : reasonId}
        data-testid="city-new-ideas"
      >
        <RefreshIcon size={18} />
        New ideas for this day
      </button>
      {ideas.allowed ? null : (
        <p id={reasonId} className="city-reason" data-testid="city-new-ideas-reason">
          {ideas.reason}
        </p>
      )}
    </div>
  );
}
