"use client";

import { type ReactNode, useId } from "react";

// A group of checkbox chips (interests, bases) with an optional count on each and a cap on how
// many can be picked. At the cap, unpicked chips are disabled and the hint says why. An error is
// tied to every checkbox (aria-describedby and aria-invalid), since a group role cannot carry
// aria-invalid, and focus lands on a checkbox when the form reports it.

export interface ChipChoice {
  value: string;
  label: string;
  count?: number;
  countNoun?: string; // "places", read after the count by screen readers
}

interface ChipChoicesProps {
  legend: string;
  choices: readonly ChipChoice[];
  selected: readonly string[];
  max: number;
  onToggle: (value: string) => void;
  hint?: string;
  error?: string;
  errorId?: string;
  testId?: string;
  listId?: string; // for a control elsewhere that changes the list (aria-controls)
  after?: ReactNode; // shown between the chips and the hint, such as "Show all interests"
}

export function ChipChoices(props: ChipChoicesProps) {
  const { legend, choices, selected, max, onToggle, hint, error, errorId, testId, listId } = props;
  const hintId = useId();
  const full = selected.length >= max;
  const describedBy = [hint || full ? hintId : null, error ? errorId : null].filter(Boolean);
  const describedByText = describedBy.length > 0 ? describedBy.join(" ") : undefined;
  return (
    <fieldset className="field" data-testid={testId} aria-describedby={describedByText}>
      <legend className="field-label">{legend}</legend>
      <div className="flex flex-wrap gap-2" id={listId}>
        {choices.map((choice) => {
          const checked = selected.includes(choice.value);
          return (
            <label key={choice.value} className="choice-chip" data-checked={checked || undefined}>
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                disabled={!checked && full}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error ? true : undefined}
                onChange={() => onToggle(choice.value)}
                value={choice.value}
              />
              <span>{choice.label}</span>
              {choice.count === undefined ? null : (
                <span className="choice-count">
                  {choice.count}
                  <span className="sr-only"> {choice.countNoun ?? "places"}</span>
                </span>
              )}
            </label>
          );
        })}
      </div>
      {props.after}
      {hint || full ? (
        <p id={hintId} className="field-hint">
          {full ? `You picked the most allowed (${max}). Unpick one to choose another.` : hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
