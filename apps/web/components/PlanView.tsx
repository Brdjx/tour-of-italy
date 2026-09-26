"use client";

import {
  type Itinerary,
  type PlannerContext,
  summaryForTrip,
  type Violation,
  withReplannedDays,
} from "@italy/planner";
import { type CSSProperties, type Ref, useEffect, useMemo, useRef } from "react";
import { tripViolations, WARNING_NEXT_STEP } from "../lib/chips";
import { type DayMade, shownWarnings } from "../lib/dayCity";
import {
  type DayChoices,
  dayChoices,
  lockedText,
  planningText,
  type RouteView,
  routeView,
  waitingText,
} from "../lib/dayRoute";
import { longDate } from "../lib/format";
import type { ItineraryState } from "../lib/itineraryReducer";
import { buildTripView, type DayView, type RowView } from "../lib/timetable";
import { tripDateRange } from "../lib/tripSummary";
import { type DayRoute, type RoutePending, SLOW_DAY_TEXT } from "../lib/useDayRoute";
import { useStopDetails } from "../lib/useStopDetails";
import { DayMap } from "./DayMap";
import { DAY_PANEL_ID, DayTabs, dayTabId, type TabBusy } from "./DayTabs";
import { type DayPlanning, DayTimetable } from "./DayTimetable";
import { RouteSheet } from "./RouteSheet";
import { StopDetailsSheet } from "./StopDetailsSheet";

// The plan: the AI summary, trip-level notes, day tabs, and the active day's board and map (below
// it on phones and tablets in portrait, beside it from 1024 px). The summary is shown for the
// places the trip has now (summaryForTrip), the same cleaning the server applies when the trip is
// saved, so a sentence about a stop the traveler removed goes with it. The trip header above the
// plan (TripSummary) holds Edit trip, Copy link, the source line and Undo. Switching days slides
// the new board in from the side it was reached from; the map stays mounted so its camera can
// move to the new day instead of starting over. The day's details sheet lives here, so a stop's
// photo or Details on the board and its marker on the map (on the page or full screen) open the
// same sheet on the same stop, and stepping in it to another stop marks that stop's row as the
// one open (useStopDetails). The route sheet lives here too, opened from the city on any day's
// line. While days of a route are planned, each shows its skeleton until its turn is done, then
// its new stops (still one edit, applied when the last day is in), and editing waits.

const NO_ROWS: readonly RowView[] = [];

export interface PlanViewProps {
  plan: ItineraryState;
  ctx: PlannerContext;
  activeDay: number;
  animateDay: number;
  headingRef: Ref<HTMLHeadingElement>;
  onSelectDay: (day: number) => void;
  onSwap: (day: number, stop: number) => void;
  onRemove: (day: number, stop: number) => void;
  onMove: (day: number, stop: number, direction: "up" | "down") => void;
  route?: DayRoute; // the route sheet; without it the city on each day's line is plain text
}

/** Where each day of a run stands: planned, being planned, waiting, or not in it. */
type DayStatus = "done" | "planning" | "waiting" | null;

function statusOf(pending: RoutePending | null, day: number): DayStatus {
  const step = pending?.run.jobs.findIndex((job) => job.day === day) ?? -1;
  if (!pending || step === -1) return null;
  if (step < pending.step) return "done";
  return step === pending.step ? "planning" : "waiting";
}

/**
 * The trip as the page shows it while a run plans: the days planned so far put in (as the edit
 * at the end will put them), each day's record of how it was made, and the errors of the days the
 * run leaves as they are. Without a run, the plan itself.
 */
// Decision: the days already planned show at once, read-only, so a route of three new cities
// fills in a day at a time instead of waiting for the last. They are the same days the one edit
// applies, since each was checked against the trip as planned before it.
function shownTrip(
  plan: ItineraryState,
  pending: RoutePending | null,
  ctx: PlannerContext,
): { itinerary: Itinerary | null; made: (DayMade | null)[]; errors: Violation[] } {
  const itinerary = plan.itinerary;
  if (!itinerary || !pending) return { itinerary, made: plan.dayMade, errors: plan.errors };
  const days = pending.done.map(({ day, dayPlan }) => ({ day, dayPlan }));
  const done = new Map(pending.done.map((result) => [result.day, result.made]));
  const run = new Set(pending.run.jobs.map((job) => job.day));
  return {
    itinerary: days.length > 0 ? withReplannedDays(itinerary, days, ctx) : itinerary,
    made: plan.dayMade.map((made, index) => done.get(index) ?? made),
    errors: plan.errors.filter((error) => error.day === undefined || !run.has(error.day)),
  };
}

export function PlanView(props: PlanViewProps) {
  const { plan, ctx, activeDay, animateDay, headingRef } = props;
  const shownDay = useRef(activeDay);
  const from = activeDay >= shownDay.current ? 1 : -1;
  useEffect(() => {
    shownDay.current = activeDay;
  }, [activeDay]);
  const route = props.route;
  const pending = route?.pending ?? null;
  // As a run starts the page shows its first day; its heading, which has focus, comes into view
  // clear of the pinned tabs (the page's scroll padding).
  const run = pending?.run ?? null;
  useEffect(() => {
    const first = run?.jobs[0];
    if (first === undefined) return;
    document.getElementById(`day-heading-${first.day}`)?.scrollIntoView?.({ block: "nearest" });
  }, [run]);
  const shown = useMemo(() => shownTrip(plan, pending, ctx), [plan, pending, ctx]);
  const itinerary = shown.itinerary;
  // The warnings the page shows: none saying a day the traveler moved is off their bases.
  const warnings = useMemo(
    () => (itinerary ? shownWarnings(itinerary.warnings, shown.made) : []),
    [itinerary, shown.made],
  );
  const days = useMemo(() => {
    const views = itinerary ? buildTripView({ ...itinerary, warnings }, ctx, shown.errors) : [];
    // A day still to be planned in a run is named by its new city, on its tab too.
    return views.map((view): DayView => {
      const step = pending?.run.jobs.findIndex((job) => job.day === view.index) ?? -1;
      const name = step === -1 ? undefined : pending?.run.names[step];
      const waiting = statusOf(pending, view.index) !== "done";
      return name && waiting ? { ...view, anchorName: name } : view;
    });
  }, [itinerary, warnings, ctx, shown.errors, pending]);
  const summary = useMemo(
    () => (itinerary ? summaryForTrip(itinerary, ctx) : undefined),
    [itinerary, ctx],
  );
  const day = days[activeDay] ?? days[0];
  const details = useStopDetails(day?.rows ?? NO_ROWS);
  const sheet = route?.sheet ?? null;
  const sheetOpen = sheet?.open ?? false;
  // Decision: worked out while the sheet is open only (a few milliseconds for the route, about
  // ten for a day's five cities), and the last of each kept while it closes, so it leaves with
  // its content and later edits cost nothing.
  const kept = useRef<{ view: RouteView | null; choices: DayChoices | null }>({
    view: null,
    choices: null,
  });
  const base = plan.itinerary;
  const draft = sheet?.draft;
  const sheetView = useMemo(
    () => (base && sheetOpen && draft ? routeView(base, draft, ctx) : kept.current.view),
    [base, sheetOpen, draft, ctx],
  );
  const sheetDay = sheet?.day ?? 0;
  const onDayLevel = sheet?.level === "day";
  const choices = useMemo(
    () =>
      base && sheetOpen && draft && onDayLevel
        ? dayChoices(base, draft, sheetDay, ctx)
        : kept.current.choices,
    [base, sheetOpen, draft, onDayLevel, sheetDay, ctx],
  );
  kept.current = { view: sheetView, choices };
  // Where focus goes as the sheet closes: the heading of the first day a run plans (the page
  // shows that day), or back to the city pill that opened it.
  // Decision: the pill by its id, not whatever had focus as the sheet opened. Safari does not
  // focus a button that is tapped, so on an iPhone the sheet would find nothing to return to.
  const after = sheet?.after ?? null;
  const routeReturn = useMemo(
    () => ({
      get current(): HTMLElement | null {
        const id = after === null ? `day-city-${activeDay}` : `day-heading-${after}`;
        return document.getElementById(id);
      },
    }),
    [after, activeDay],
  );
  if (!itinerary) return null;
  const tripNotes = tripViolations([...shown.errors, ...warnings]);
  const status = day ? statusOf(pending, day.index) : null;
  const busy: TabBusy[] = days.map((view) => {
    const state = statusOf(pending, view.index);
    return state === "planning" || state === "waiting" ? state : null;
  });
  const planning = day && pending ? dayPlanning(pending, day.index, status) : null;
  const locked = pending && !planning ? lockedText(pending.run, pending.step) : null;
  return (
    <section aria-labelledby="plan-title" className="plan" data-testid="plan-view">
      <h2 id="plan-title" className="sr-only">
        Your plan
      </h2>
      {summary ? (
        <p className="plan-summary" data-testid="plan-summary">
          {summary}
        </p>
      ) : null}
      {tripNotes.length > 0 ? (
        <ul
          className="mt-3 space-y-1"
          aria-label="Notes about the whole trip"
          data-testid="trip-notes"
        >
          {tripNotes.map((note) => (
            <li
              key={`${note.code}-${note.placeId ?? ""}`}
              className={`trip-note ${note.severity === "error" ? "trip-note--error" : ""}`}
            >
              {note.severity === "error" ? <span className="sr-only">Problem: </span> : null}
              {note.detail}
              {note.severity === "warning" && WARNING_NEXT_STEP[note.code]
                ? ` ${WARNING_NEXT_STEP[note.code]}`
                : null}
            </li>
          ))}
        </ul>
      ) : null}
      <DayTabs days={days} active={day?.index ?? 0} onSelect={props.onSelectDay} busy={busy} />
      {day ? (
        <div
          role="tabpanel"
          id={DAY_PANEL_ID}
          aria-labelledby={dayTabId(day.index)}
          className="day-panel pt-5"
        >
          <div
            key={day.index}
            className={animateDay === day.index ? "day-board" : "day-board day-panel-enter"}
            style={{ "--from": from } as CSSProperties}
          >
            <DayTimetable
              view={day}
              animate={animateDay === day.index}
              changedStop={plan.changed?.day === day.index ? plan.changed.stop : null}
              headingRef={headingRef}
              onSwap={(stop) => props.onSwap(day.index, stop)}
              onRemove={(stop) => props.onRemove(day.index, stop)}
              onMove={(stop, direction) => props.onMove(day.index, stop, direction)}
              details={details.control}
              city={
                route
                  ? {
                      onOpen: () => route.open(day.index),
                      open: sheetOpen && sheetDay === day.index,
                      disabled: pending !== null,
                    }
                  : undefined
              }
              planning={planning}
              locked={locked}
              made={shown.made[day.index] ?? null}
            />
          </div>
          <DayMap
            days={days}
            active={day.index}
            ctx={ctx}
            onSelectDay={props.onSelectDay}
            onDetails={details.control.open}
            busy={planning !== null}
          />
        </div>
      ) : null}
      {day ? <StopDetailsSheet {...details.sheet} date={day.day.date} /> : null}
      {route && sheet ? (
        <RouteSheet
          open={sheet.open}
          level={sheet.level}
          day={sheet.day}
          moved={sheet.moved}
          view={sheetView}
          choices={choices}
          dates={(base?.days ?? []).map((planned) => longDate(planned.date))}
          range={base ? tripDateRange(base.request.startDate, base.days.length) : ""}
          said={route.said}
          onOpenDay={route.openDay}
          onBack={route.back}
          onChoose={route.choose}
          onIdeas={route.ideas}
          onReset={route.reset}
          onConfirm={route.confirm}
          onClose={route.close}
          returnFocus={routeReturn}
        />
      ) : null}
    </section>
  );
}

/** The day's line while a run plans it: being planned now, or waiting its turn. */
function dayPlanning(pending: RoutePending, day: number, status: DayStatus): DayPlanning | null {
  const step = pending.run.jobs.findIndex((job) => job.day === day);
  if (status === "planning") {
    const slow = pending.slow ? SLOW_DAY_TEXT : null;
    return { text: planningText(pending.run, step), slow, waiting: false };
  }
  if (status === "waiting")
    return { text: waitingText(pending.run, step), slow: null, waiting: true };
  return null;
}
