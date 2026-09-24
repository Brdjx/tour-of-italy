"use client";

import type { CSSProperties } from "react";
import {
  clockDateTime,
  formatDuration,
  placeSubtitle,
  priceLabel,
  priceSymbols,
  ratingText,
} from "../lib/format";
import type { RowView } from "../lib/timetable";
import { ClockText } from "./Clock";
import { type StopActionHandlers, StopActions } from "./StopActions";
import { TravelLeg } from "./TravelLeg";
import { WarningChips } from "./WarningChip";

// One stop in the timetable: the leg that leads to it, then times in the left gutter and the
// place on the right (meal label, name, type and neighborhood, visit length, price, rating,
// chips, the reason with its AI or rule marker, and the edit actions). A long visit that stands
// in for a meal says so where the meal label goes. All text from the data or the AI is rendered
// as React text, never as HTML.

interface StopRowProps extends StopActionHandlers {
  row: RowView;
  dayIndex: number;
  date: string;
  isLast: boolean;
  dayStopCount: number;
  changed: boolean; // the last edit touched this row
}

const ROLE_LABEL = { lunch: "Lunch", dinner: "Dinner" } as const;

/** "Lunch during this visit", "Lunch and dinner during this visit", or null. */
export function coveredLabel(meals: readonly string[]): string | null {
  if (meals.length === 0) return null;
  const words = meals.length > 1 ? "Lunch and dinner" : meals[0] === "lunch" ? "Lunch" : "Dinner";
  return `${words} during this visit`;
}

export function StopRow(props: StopRowProps) {
  const { row, dayIndex, date, isLast, dayStopCount, changed } = props;
  const { stop, place } = row;
  const name = place?.name ?? "A place no longer in the data";
  const rating = ratingText(place?.rating ?? null);
  const price = place?.priceLevel ?? null;
  const style = { "--i": row.index } as CSSProperties;
  return (
    <li
      id={`stop-${dayIndex}-${row.index}`}
      className={`stop-row${row.flagged ? " stop-row--flagged" : ""}${changed ? " stop-row--changed" : ""}`}
      style={style}
      data-testid="stop-row"
      data-place-id={stop.placeId}
      data-flagged={row.flagged ? "true" : undefined}
    >
      <TravelLeg leg={row.leg} />
      <div className="timetable-grid">
        <p className="stop-times">
          <time dateTime={clockDateTime(date, stop.start)} className="block font-semibold">
            <ClockText minutes={stop.start} />
          </time>
          <span className="sr-only"> to </span>
          <time dateTime={clockDateTime(date, stop.end)} className="block text-sm text-muted">
            <ClockText minutes={stop.end} />
          </time>
        </p>
        <div className="stop-body">
          <RoleLabel row={row} />
          <h3 className="text-xl font-semibold leading-snug text-fg [overflow-wrap:anywhere]">
            {name}
          </h3>
          {place ? <p className="text-sm text-muted">{placeSubtitle(place)}</p> : null}
          <dl className="mt-1 flex flex-wrap gap-x-4 text-sm text-fg">
            <div>
              <dt className="sr-only">Visit length</dt>
              <dd className="tabular">{formatDuration(stop.end - stop.start)}</dd>
            </div>
            {price === null ? null : (
              <div>
                <dt className="sr-only">Price</dt>
                <dd>
                  <span aria-hidden="true">{priceSymbols(price)}</span>
                  <span className="sr-only">{priceLabel(price)}</span>
                </dd>
              </div>
            )}
            {rating === null ? null : (
              <div>
                <dt className="sr-only">Rating</dt>
                <dd>Rated {rating}</dd>
              </div>
            )}
          </dl>
          <WarningChips chips={row.chips} />
          {row.reason ? <Reason text={row.reason} ai={stop.reasonSource === "ai"} /> : null}
          <StopActions
            name={name}
            canMoveUp={row.index > 0}
            canMoveDown={!isLast}
            canRemove={dayStopCount > 1}
            onSwap={props.onSwap}
            onRemove={props.onRemove}
            onMove={props.onMove}
          />
        </div>
      </div>
    </li>
  );
}

function RoleLabel({ row }: { row: RowView }) {
  const role = row.stop.role;
  const text = role === "visit" ? coveredLabel(row.coveredMeals) : ROLE_LABEL[role];
  if (!text) return null;
  return (
    <p className="text-sm font-semibold text-accent" data-testid="meal-label">
      {text}
    </p>
  );
}

function Reason({ text, ai }: { text: string; ai: boolean }) {
  return (
    <p className="mt-1 flex max-w-prose gap-2 text-sm text-muted" data-testid="stop-reason">
      <span
        aria-hidden="true"
        className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${ai ? "bg-accent" : "border border-muted"}`}
      />
      <span>
        <span className="sr-only">
          {ai ? "Why, from the AI planner: " : "Why, from the rules: "}
        </span>
        {text}
      </span>
    </p>
  );
}
