"use client";

import { useId } from "react";

// Free-text notes for the AI planner, with a live character count. The textarea's maxLength
// stops input at the limit; the counter turns to the warning style in the last 50 characters.

/** Characters left at which the counter starts to stand out. */
export const NOTES_WARN_AT = 50;

interface NotesFieldProps {
  value: string;
  max: number;
  onChange: (value: string) => void;
  error?: string;
}

export function NotesField({ value, max, onChange, error }: NotesFieldProps) {
  const id = useId();
  const left = max - value.length;
  const describedBy = [`${id}-count`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="field" data-testid="notes-field">
      <label htmlFor={`${id}-notes`} className="field-label">
        Anything else? Used by the AI planner.
      </label>
      <textarea
        id={`${id}-notes`}
        name="notes"
        rows={3}
        maxLength={max}
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, max))}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className="text-input min-h-24 py-2"
        placeholder="For example: we love long lunches and want one evening walk."
      />
      <p
        id={`${id}-count`}
        className={`field-hint tabular-nums ${left <= NOTES_WARN_AT ? "font-semibold text-fg" : ""}`}
        data-testid="notes-counter"
      >
        {value.length} of {max} characters
      </p>
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
