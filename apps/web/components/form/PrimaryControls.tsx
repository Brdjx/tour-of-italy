"use client";

import type { Pace } from "@italy/planner";
import { useId } from "react";
import type { FormErrors, TripFormValues } from "../../lib/tripForm";
import type { PrimaryOptions } from "../../lib/tripOptions";
import { SegmentedField } from "./SegmentedField";

// The two controls that are always on screen: the start date and the pace. Both come from the
// planner's own constants, so they work from the first paint, before any data has loaded.

interface PrimaryControlsProps {
  options: PrimaryOptions;
  values: Pick<TripFormValues, "startDate" | "pace">;
  errors: FormErrors;
  onDate: (value: string) => void;
  onPace: (value: Pace) => void;
}

export function PrimaryControls({ options, values, errors, onDate, onPace }: PrimaryControlsProps) {
  const id = useId();
  const pace = options.paces.find((option) => option.id === values.pace);
  return (
    <div className="primary-controls">
      <div className="field" data-field="startDate">
        <label htmlFor={`${id}-date`} className="field-label">
          Start date
        </label>
        <input
          id={`${id}-date`}
          type="date"
          required
          value={values.startDate}
          onChange={(event) => onDate(event.target.value)}
          aria-describedby={`${id}-date-hint${errors.startDate ? ` ${id}-date-error` : ""}`}
          aria-invalid={errors.startDate ? true : undefined}
          className="text-input"
          data-testid="start-date"
        />
        <p id={`${id}-date-hint`} className="field-hint">
          Your trip runs for {options.tripDays} days from this date.
        </p>
        {errors.startDate ? (
          <p id={`${id}-date-error`} className="field-error">
            {errors.startDate}
          </p>
        ) : null}
      </div>
      <SegmentedField<Pace>
        legend="Pace"
        name={`${id}-pace`}
        segments={options.paces.map((option) => ({ value: option.id, label: option.label }))}
        value={values.pace}
        onChange={onPace}
        hint={pace?.hint}
        testId="pace-field"
      />
    </div>
  );
}
