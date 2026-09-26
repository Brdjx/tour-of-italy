"use client";

import { type CSSProperties, type KeyboardEvent, useRef } from "react";
import type { DayView } from "../lib/timetable";

// Day tabs, following the ARIA tabs pattern: one tab stop, arrow keys move between days, Home
// and End jump to the first and last. The bar is pinned under the status bar on phones. Narrow
// tabs show the date; when the trip has two bases they show the base instead, so the travel day
// is visible (the day heading below always has the full date). While days of a route are planned
// again, each of their tabs carries the board's busy flap, turning on the day being planned and
// still on a day waiting its turn, so the progress shows from whichever day is on screen.

export const DAY_PANEL_ID = "day-panel";

export function dayTabId(index: number): string {
  return `day-tab-${index}`;
}

/** A day of a route being planned: the one asked for now, or one waiting its turn. */
export type TabBusy = "planning" | "waiting" | null;

interface DayTabsProps {
  days: readonly DayView[];
  active: number;
  onSelect: (index: number) => void;
  busy?: readonly TabBusy[]; // per day, while days are planned again
}

const BUSY_WORDS = { planning: ", being planned", waiting: ", waiting to be planned" } as const;

export function DayTabs({ days, active, onSelect, busy = [] }: DayTabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const multiBase = new Set(days.map((day) => day.anchorName)).size > 1;

  const move = (event: KeyboardEvent, index: number) => {
    const last = days.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next);
    refs.current[next]?.focus();
  };

  // The gold indicator under the chosen day is drawn in CSS from these two numbers.
  const indicator = { "--days": days.length, "--active": active } as CSSProperties;
  return (
    <div
      role="tablist"
      aria-label="Trip days"
      className="day-tabs"
      style={indicator}
      data-testid="day-tabs"
      data-multi-base={multiBase ? "true" : undefined}
    >
      {days.map((day, index) => {
        const selected = index === active;
        const state = busy[index] ?? null;
        return (
          <button
            key={day.day.date}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={dayTabId(index)}
            aria-selected={selected}
            aria-controls={DAY_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            className="day-tab"
            data-testid={`day-tab-${index + 1}`}
            data-busy={state ?? undefined}
            onClick={() => onSelect(index)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="day-tab-name">
              Day {index + 1}
              {state ? (
                <>
                  <span
                    className={
                      state === "waiting"
                        ? "flap-spinner flap-spinner--tab flap-spinner--still"
                        : "flap-spinner flap-spinner--tab"
                    }
                    aria-hidden="true"
                  />
                  <span className="sr-only">{BUSY_WORDS[state]}</span>
                </>
              ) : null}
            </span>
            <span className="day-tab-when">
              <span className="day-tab-date">{day.tabLabel}</span>
              <span className="day-tab-city">
                <span className="day-tab-sep">, </span>
                {day.anchorName}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
