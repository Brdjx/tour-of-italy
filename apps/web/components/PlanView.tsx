"use client";

import type { PlannerContext } from "@italy/planner";
import { type CSSProperties, type Ref, useEffect, useMemo, useRef } from "react";
import { tripViolations, WARNING_NEXT_STEP } from "../lib/chips";
import type { ItineraryState } from "../lib/itineraryReducer";
import { buildTripView } from "../lib/timetable";
import { DayMap } from "./DayMap";
import { DAY_PANEL_ID, DayTabs, dayTabId } from "./DayTabs";
import { DayTimetable } from "./DayTimetable";

// The plan: the AI summary, trip-level notes, day tabs, and the active day's board and map (below
// it on phones and tablets in portrait, beside it from 1024 px). The trip header above the plan
// (TripSummary) holds Edit trip, Copy link, the source line and Undo. Switching days slides
// the new board in from the side it was reached from; the map stays mounted so its camera can
// move to the new day instead of starting over.

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
}

export function PlanView(props: PlanViewProps) {
  const { plan, ctx, activeDay, animateDay, headingRef } = props;
  const shownDay = useRef(activeDay);
  const from = activeDay >= shownDay.current ? 1 : -1;
  useEffect(() => {
    shownDay.current = activeDay;
  }, [activeDay]);
  const itinerary = plan.itinerary;
  const days = useMemo(
    () => (itinerary ? buildTripView(itinerary, ctx, plan.errors) : []),
    [itinerary, ctx, plan.errors],
  );
  if (!itinerary) return null;
  const day = days[activeDay] ?? days[0];
  const tripNotes = tripViolations([...plan.errors, ...itinerary.warnings]);
  return (
    <section aria-labelledby="plan-title" className="plan" data-testid="plan-view">
      <h2 id="plan-title" className="sr-only">
        Your plan
      </h2>
      {itinerary.summary ? (
        <p className="plan-summary" data-testid="plan-summary">
          {itinerary.summary}
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
      <DayTabs days={days} active={day?.index ?? 0} onSelect={props.onSelectDay} />
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
            />
          </div>
          <DayMap day={day.day} dayNumber={day.index + 1} ctx={ctx} />
        </div>
      ) : null}
    </section>
  );
}
