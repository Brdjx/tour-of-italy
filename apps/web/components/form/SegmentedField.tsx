"use client";

import { useId } from "react";

// A segmented control built from native radio buttons, so arrow keys, form semantics, and
// screen reader announcements come from the browser. Each segment is at least 44 px tall.

export interface Segment<T extends string> {
  value: T;
  label: string;
  srLabel?: string; // fuller name for screen readers, e.g. "Up to price level 2"
}

interface SegmentedFieldProps<T extends string> {
  legend: string;
  name: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  hint?: string;
  testId?: string;
}

export function SegmentedField<T extends string>(props: SegmentedFieldProps<T>) {
  const { legend, name, segments, value, onChange, hint, testId } = props;
  const hintId = useId();
  return (
    <fieldset className="field" data-testid={testId} aria-describedby={hint ? hintId : undefined}>
      <legend className="field-label">{legend}</legend>
      <div className="segmented">
        {segments.map((segment) => (
          <label key={segment.value} className="segment">
            <input
              type="radio"
              name={name}
              value={segment.value}
              checked={segment.value === value}
              onChange={() => onChange(segment.value)}
              className="sr-only"
            />
            <span aria-hidden={segment.srLabel ? "true" : undefined}>{segment.label}</span>
            {segment.srLabel ? <span className="sr-only">{segment.srLabel}</span> : null}
          </label>
        ))}
      </div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}
