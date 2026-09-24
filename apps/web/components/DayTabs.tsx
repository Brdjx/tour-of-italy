"use client";

import { type KeyboardEvent, useRef } from "react";
import type { DayView } from "../lib/timetable";

// Day tabs, following the ARIA tabs pattern: one tab stop, arrow keys move between days, Home
// and End jump to the first and last. The bar is pinned under the status bar on phones. Narrow
// tabs show the date; when the trip has two bases they show the base instead, so the travel day
// is visible (the day heading below always has the full date).

export const DAY_PANEL_ID = "day-panel";

export function dayTabId(index: number): string {
  return `day-tab-${index}`;
}

interface DayTabsProps {
  days: readonly DayView[];
  active: number;
  onSelect: (index: number) => void;
}

export function DayTabs({ days, active, onSelect }: DayTabsProps) {
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

  return (
    <div
      role="tablist"
      aria-label="Trip days"
      className="day-tabs"
      data-testid="day-tabs"
      data-multi-base={multiBase ? "true" : undefined}
    >
      {days.map((day, index) => {
        const selected = index === active;
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
            onClick={() => onSelect(index)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="block text-base font-semibold">Day {index + 1}</span>
            <span className="block text-sm">
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
