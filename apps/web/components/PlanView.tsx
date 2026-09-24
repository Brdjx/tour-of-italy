"use client";

import type { PlannerContext } from "@italy/planner";
import { type Ref, useMemo } from "react";
import { tripViolations, WARNING_NEXT_STEP } from "../lib/chips";
import { type ItineraryState, undoLabel } from "../lib/itineraryReducer";
import { buildTripView } from "../lib/timetable";
import { DayMap } from "./DayMap";
import { DAY_PANEL_ID, DayTabs, dayTabId } from "./DayTabs";
import { DayTimetable } from "./DayTimetable";
import { UndoIcon } from "./icons";
import { ShareButton } from "./ShareButton";
import { SourceBadge } from "./SourceBadge";

// The plan: source badge and toolbar (undo, copy link), the AI summary, trip-level notes, day
// tabs, and the active day's timetable and map (below it on phones and tablets in portrait,
// beside it from 1024 px). "Edit trip" lives in the trip summary line above the plan.

export interface PlanViewProps {
  plan: ItineraryState;
  ctx: PlannerContext;
  activeDay: number;
  animateDay: number;
  headingRef: Ref<HTMLHeadingElement>;
  onSelectDay: (day: number) => void;
  onUndo: () => void;
  onSwap: (day: number, stop: number) => void;
  onRemove: (day: number, stop: number) => void;
  onMove: (day: number, stop: number, direction: "up" | "down") => void;
  onStatus: (message: string) => void;
}

export function PlanView(props: PlanViewProps) {
  const { plan, ctx, activeDay, animateDay, headingRef } = props;
  const itinerary = plan.itinerary;
  const days = useMemo(
    () => (itinerary ? buildTripView(itinerary, ctx, plan.errors) : []),
    [itinerary, ctx, plan.errors],
  );
  if (!itinerary) return null;
  const day = days[activeDay] ?? days[0];
  const undo = undoLabel(plan);
  const tripNotes = tripViolations([...plan.errors, ...itinerary.warnings]);
  return (
    <section aria-labelledby="plan-title" className="plan" data-testid="plan-view">
      <h2 id="plan-title" className="sr-only">
        Your plan
      </h2>
      <div className="plan-toolbar">
        <SourceBadge
          itinerary={itinerary}
          origin={plan.origin}
          cause={plan.cause}
          errors={plan.errors.length}
          edited={plan.history.length > 0}
        />
        <div className="flex flex-wrap items-start gap-1">
          {undo ? (
            <button
              type="button"
              className="toolbar-button"
              onClick={props.onUndo}
              data-testid="undo-button"
            >
              <UndoIcon size={18} />
              {undo}
            </button>
          ) : null}
          <ShareButton itinerary={itinerary} onStatus={props.onStatus} />
        </div>
      </div>
      {itinerary.summary ? (
        <p className="mt-2 max-w-prose text-base text-fg" data-testid="plan-summary">
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
          className="day-panel pt-4"
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
          <DayMap day={day.day} dayNumber={day.index + 1} ctx={ctx} />
        </div>
      ) : null}
    </section>
  );
}
