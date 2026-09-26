"use client";

import { type CSSProperties, type RefObject, useId, useRef } from "react";
import type { CityChoice } from "../lib/dayCity";
import { CheckIcon, ChevronIcon, RefreshIcon } from "./icons";
import { Sheet, SheetTitleBar } from "./Sheet";

// Change city: every base for one day, from the city pill on the day's heading. A bottom sheet on
// phones and a centred panel from 768 px (Sheet). The day's own city comes first, marked, with
// "New ideas for this day"; then the other cities, each one button with one factual line (the
// travel it means and how many places the city has). A city the day can take has the onward
// chevron after its name, as the city pill has, so it reads as pressable on touch as well. A city
// the planner does not allow for the day stays in the list, dimmed in place with its reason and
// no chevron, so the traveler learns what to change first ("Move day 3 to Florence first")
// instead of wondering where it went. Choosing plans the day at once; the sheet closes and the
// day's board says it is planning.

export const CITY_SHEET_ID = "city-sheet";

// Decision: said once at the top rather than on every row. Both choices keep the other days as
// they are and plan this day from places the trip does not have yet, so no place repeats.
export const CITY_SHEET_LEDE =
  "The other days keep their places. This day is planned again with places your trip does not have yet.";

interface DayCitySheetProps {
  open: boolean;
  day: number | null; // 0-based; kept while the sheet closes, so it leaves with its content
  date: string; // "Friday 16 October"
  choices: readonly CityChoice[];
  onChoose: (anchorId: string) => void;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}

export function DayCitySheet(props: DayCitySheetProps) {
  const { open, day, date, choices, onChoose, onClose, returnFocus } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const current = choices.find((choice) => choice.current);
  const others = choices.filter((choice) => !choice.current);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      id={CITY_SHEET_ID}
      labelledBy={titleId}
      size="fit"
      className="city-sheet"
      testId="city-sheet"
      initialFocus={headingRef}
      returnFocus={returnFocus}
      header={
        <SheetTitleBar
          titleId={titleId}
          titleRef={headingRef}
          title={day === null ? "" : `Change city for day ${day + 1}`}
          subtitle={day === null ? null : <p className="stop-subtitle">{date}</p>}
          closeLabel="Close"
          closeTestId="city-close"
          onClose={onClose}
        />
      }
    >
      {day === null ? null : (
        <div className="city-body" data-testid="city-choices">
          <p className="city-lede">{CITY_SHEET_LEDE}</p>
          {current ? <CurrentCity choice={current} onChoose={onChoose} /> : null}
          <ul className="city-list" aria-label="Other cities">
            {others.map((choice, index) => (
              <li key={choice.anchorId} style={{ "--i": index + 1 } as CSSProperties}>
                <CityOption choice={choice} onChoose={onChoose} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

/** The day's own city: marked as the day's, with New ideas for this day. */
function CurrentCity({
  choice,
  onChoose,
}: {
  choice: CityChoice;
  onChoose: (anchorId: string) => void;
}) {
  const reasonId = useId();
  return (
    <div className="city-current" data-testid="city-current" data-anchor-id={choice.anchorId}>
      <p className="city-current-head">
        <span className="city-name t-tab">{choice.name}</span>
        <span className="city-now">
          <CheckIcon size={16} />
          This day
        </span>
      </p>
      <p className="city-line">{choice.line}</p>
      <button
        type="button"
        className="pill pill--line city-ideas"
        onClick={choice.allowed ? () => onChoose(choice.anchorId) : undefined}
        aria-disabled={choice.allowed ? undefined : true}
        aria-describedby={choice.allowed ? undefined : reasonId}
        data-testid="city-new-ideas"
      >
        <RefreshIcon size={18} />
        New ideas for this day
      </button>
      {choice.allowed ? null : (
        <p id={reasonId} className="city-reason" data-testid="city-new-ideas-reason">
          {choice.reason}
        </p>
      )}
    </div>
  );
}

/**
 * Another city: one button, named by the city, with its line (or, when the planner does not
 * allow it, its reason) as the button's description. Only a city the day can take has the
 * chevron.
 */
function CityOption({
  choice,
  onChoose,
}: {
  choice: CityChoice;
  onChoose: (anchorId: string) => void;
}) {
  const nameId = useId();
  const lineId = useId();
  return (
    <button
      type="button"
      className="city-option"
      onClick={choice.allowed ? () => onChoose(choice.anchorId) : undefined}
      aria-disabled={choice.allowed ? undefined : true}
      aria-labelledby={nameId}
      aria-describedby={lineId}
      data-testid="city-option"
      data-anchor-id={choice.anchorId}
      data-allowed={choice.allowed ? "true" : "false"}
    >
      <span className="city-option-head">
        <span id={nameId} className="city-name t-tab">
          {choice.name}
        </span>
        {choice.allowed ? <ChevronIcon size={16} className="city-option-chevron" /> : null}
      </span>
      <span id={lineId} className={choice.allowed ? "city-line" : "city-reason"}>
        {choice.allowed ? choice.line : choice.reason}
      </span>
    </button>
  );
}
