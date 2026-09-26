"use client";

import { type PlannerContext, summaryForTrip } from "@italy/planner";
import { type CSSProperties, type Ref, useEffect, useMemo, useRef } from "react";
import { tripViolations, WARNING_NEXT_STEP } from "../lib/chips";
import { type CityChoice, cityChoices, shownWarnings } from "../lib/dayCity";
import type { ItineraryState } from "../lib/itineraryReducer";
import { buildTripView, type RowView } from "../lib/timetable";
import { type DayCity, planningText, SLOW_DAY_TEXT } from "../lib/useDayCity";
import { useStopDetails } from "../lib/useStopDetails";
import { DayCitySheet } from "./DayCitySheet";
import { DayMap } from "./DayMap";
import { DAY_PANEL_ID, DayTabs, dayTabId } from "./DayTabs";
import { DayTimetable } from "./DayTimetable";
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
// one open (useStopDetails). The Change city sheet lives here too, opened from the city on the
// day's heading line; while a day is planned again its board is a skeleton and its map dims.

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
  dayCity?: DayCity; // Change city; without it the city on each day's line is plain text
}

export function PlanView(props: PlanViewProps) {
  const { plan, ctx, activeDay, animateDay, headingRef } = props;
  const shownDay = useRef(activeDay);
  const from = activeDay >= shownDay.current ? 1 : -1;
  useEffect(() => {
    shownDay.current = activeDay;
  }, [activeDay]);
  const itinerary = plan.itinerary;
  // The warnings the page shows: none saying a day the traveler moved is off their bases.
  const warnings = useMemo(
    () => (itinerary ? shownWarnings(itinerary.warnings, plan.dayMade) : []),
    [itinerary, plan.dayMade],
  );
  const days = useMemo(
    () => (itinerary ? buildTripView({ ...itinerary, warnings }, ctx, plan.errors) : []),
    [itinerary, warnings, ctx, plan.errors],
  );
  const summary = useMemo(
    () => (itinerary ? summaryForTrip(itinerary, ctx) : undefined),
    [itinerary, ctx],
  );
  const day = days[activeDay] ?? days[0];
  const details = useStopDetails(day?.rows ?? NO_ROWS);
  const dayCity = props.dayCity;
  const sheetDay = dayCity?.sheet.day ?? null;
  const sheetOpen = dayCity?.sheet.open ?? false;
  // Decision: worked out while the sheet is open only (a few milliseconds for five cities), and
  // the last list kept while it closes, so it leaves with its content and later edits cost nothing.
  const shownChoices = useRef<CityChoice[]>([]);
  const choices = useMemo(
    () =>
      itinerary && sheetOpen && sheetDay !== null
        ? cityChoices(itinerary, sheetDay, ctx)
        : shownChoices.current,
    [itinerary, sheetOpen, sheetDay, ctx],
  );
  shownChoices.current = choices;
  // Where focus goes as the sheet closes: the day's heading once a city was chosen (its line then
  // says the day is planning), or back to the city pill that opened it.
  const cityReturn = useRef<HTMLElement | null>(null);
  if (!itinerary) return null;
  const pending = dayCity?.pending ?? null;
  const planning =
    day && pending?.day === day.index
      ? { text: planningText(pending), slow: pending.slow ? SLOW_DAY_TEXT : null }
      : null;
  const tripNotes = tripViolations([...plan.errors, ...warnings]);
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
              details={details.control}
              city={
                dayCity
                  ? {
                      onOpen: () => {
                        cityReturn.current = null;
                        dayCity.open(day.index);
                      },
                      open: dayCity.sheet.open && sheetDay === day.index,
                      disabled: pending !== null,
                    }
                  : undefined
              }
              planning={planning}
              made={plan.dayMade[day.index] ?? null}
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
      {dayCity ? (
        <DayCitySheet
          open={dayCity.sheet.open}
          day={sheetDay}
          date={sheetDay === null ? "" : (days[sheetDay]?.heading ?? "")}
          choices={choices}
          onChoose={(anchorId) => {
            if (sheetDay !== null)
              cityReturn.current = document.getElementById(`day-heading-${sheetDay}`);
            dayCity.choose(anchorId);
          }}
          onClose={dayCity.close}
          returnFocus={cityReturn}
        />
      ) : null}
    </section>
  );
}
