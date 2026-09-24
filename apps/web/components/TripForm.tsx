"use client";

import type { Pace, PriceLevel, TripRequest } from "@italy/planner";
import { type FormEvent, useId, useState } from "react";
import { keepClearOfActions } from "../lib/keepClear";
import {
  type AnchorMode,
  type FormErrors,
  type FormField,
  hasErrors,
  type TripFormValues,
  toggleValue,
  toTripRequest,
  validateTripForm,
} from "../lib/tripForm";
import type { TripOptions } from "../lib/tripOptions";
import { ChipChoices } from "./form/ChipChoices";
import { NotesField } from "./form/NotesField";
import { PlacePicker } from "./form/PlacePicker";
import { type Segment, SegmentedField } from "./form/SegmentedField";

// The trip form: start date, pace, interests, budget, bases, must-see and skip lists, and notes
// for the AI planner. Checks run on submit with one message per field; the first problem gets
// focus. The request that leaves here has passed the planner's own TripRequestSchema.

interface TripFormProps {
  options: TripOptions;
  initialValues: TripFormValues;
  planning: boolean;
  onSubmit: (request: TripRequest) => void;
}

type Budget = "any" | "1" | "2" | "3" | "4";

const BUDGETS: readonly Segment<Budget>[] = [
  { value: "any", label: "Any", srLabel: "Any price" },
  { value: "1", label: "€", srLabel: "Up to price level 1, inexpensive" },
  { value: "2", label: "€€", srLabel: "Up to price level 2, moderate" },
  { value: "3", label: "€€€", srLabel: "Up to price level 3, expensive" },
  { value: "4", label: "€€€€", srLabel: "Up to price level 4, very expensive" },
];

const ANCHOR_MODES: readonly Segment<AnchorMode>[] = [
  { value: "auto", label: "Let the planner choose" },
  { value: "choose", label: "Choose bases" },
];

/** The element that gets focus for each field's error: the first control the error describes. */
const FOCUS_TARGET: Record<FormField, string> = {
  startDate: '[data-field="startDate"] input',
  interests: '[data-field="interests"] input:not(:disabled)',
  // A base checkbox, not the "Let the planner choose" radio before it: the error is about bases.
  anchors: '[data-field="anchors"] [data-testid="anchors-field"] input:not(:disabled)',
  mustInclude: '[data-field="mustInclude"] input',
  exclude: '[data-field="exclude"] input',
  notes: '[data-field="notes"] textarea',
  form: '[data-testid="plan-button"]',
};

export function TripForm({ options, initialValues, planning, onSubmit }: TripFormProps) {
  const id = useId();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FormErrors>({});
  const { limits } = options;
  const set = <K extends keyof TripFormValues>(key: K, value: TripFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (planning) return;
    const found = validateTripForm(values, limits);
    const request = hasErrors(found) ? null : toTripRequest(values);
    const next: FormErrors = hasErrors(found) || request ? found : { form: "Check the form." };
    setErrors(next);
    const first = Object.keys(next)[0] as FormField | undefined;
    if (first) {
      event.currentTarget.querySelector<HTMLElement>(FOCUS_TARGET[first])?.focus();
      return;
    }
    if (request) onSubmit(request);
  };

  const pace = options.paces.find((option) => option.id === values.pace);
  return (
    <form
      noValidate
      onSubmit={submit}
      onFocus={keepClearOfActions}
      className="trip-form"
      data-testid="trip-form"
      aria-label="Your trip"
    >
      <div className="trip-form-fields">
        <div className="field" data-field="startDate">
          <label htmlFor={`${id}-date`} className="field-label">
            Start date
          </label>
          <input
            id={`${id}-date`}
            type="date"
            required
            value={values.startDate}
            onChange={(event) => set("startDate", event.target.value)}
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
          onChange={(value) => set("pace", value)}
          hint={pace?.hint}
          testId="pace-field"
        />
        <div data-field="interests" className="trip-form-wide">
          <ChipChoices
            legend="Interests"
            choices={options.interests.map((item) => ({
              value: item.tag,
              label: item.label,
              count: item.count,
            }))}
            selected={values.interests}
            max={limits.maxInterests}
            onToggle={(tag) =>
              set("interests", toggleValue(values.interests, tag, limits.maxInterests))
            }
            hint={`Pick up to ${limits.maxInterests}. The number is how many places match.`}
            error={errors.interests}
            errorId={`${id}-interests-error`}
            testId="interests-field"
          />
        </div>
        <SegmentedField<Budget>
          legend="Budget"
          name={`${id}-budget`}
          segments={BUDGETS}
          value={values.maxPriceLevel === null ? "any" : (String(values.maxPriceLevel) as Budget)}
          onChange={(value) =>
            set("maxPriceLevel", value === "any" ? null : (Number(value) as PriceLevel))
          }
          hint="The most you want to spend at any one place."
          testId="budget-field"
        />
        <div data-field="anchors" className="space-y-1">
          <SegmentedField<AnchorMode>
            legend="Where"
            name={`${id}-anchor-mode`}
            segments={ANCHOR_MODES}
            value={values.anchorMode}
            onChange={(value) => set("anchorMode", value)}
            testId="anchor-mode-field"
          />
          {values.anchorMode === "choose" ? (
            <ChipChoices
              legend="Bases"
              choices={options.anchors.map((anchor) => ({
                value: anchor.id,
                label: anchor.name,
                count: anchor.placeCount,
              }))}
              selected={values.anchors}
              max={limits.maxAnchors}
              onToggle={(anchor) =>
                set("anchors", toggleValue(values.anchors, anchor, limits.maxAnchors))
              }
              hint={`Up to ${limits.maxAnchors}. Nearby towns are day trips from their base.`}
              error={errors.anchors}
              errorId={`${id}-anchors-error`}
              testId="anchors-field"
            />
          ) : null}
        </div>
        <div data-field="mustInclude">
          <PlacePicker
            label="Must-see places"
            hint={`Up to ${limits.maxMustInclude}. The plan includes them when they are open.`}
            places={options.places}
            selected={values.mustInclude}
            blocked={values.exclude}
            max={limits.maxMustInclude}
            onChange={(ids) => set("mustInclude", ids)}
            error={errors.mustInclude}
            testId="must-see-field"
          />
        </div>
        <div data-field="exclude">
          <PlacePicker
            label="Places to skip"
            hint={`Up to ${limits.maxExclude}. The plan never includes them.`}
            places={options.places}
            selected={values.exclude}
            blocked={values.mustInclude}
            max={limits.maxExclude}
            onChange={(ids) => set("exclude", ids)}
            error={errors.exclude}
            testId="skip-field"
          />
        </div>
        <div data-field="notes" className="trip-form-wide">
          <NotesField
            value={values.notes}
            max={limits.notesMaxChars}
            onChange={(value) => set("notes", value)}
            error={errors.notes}
          />
        </div>
      </div>
      <div className="form-actions">
        {errors.form ? <p className="field-error mb-2">{errors.form}</p> : null}
        {planning ? (
          // On phones the planning state sits below the form, off screen; this line is the
          // visible progress there. The live region already announces it, so it is hidden from
          // screen readers.
          <p
            className="mb-2 text-sm text-muted lg:hidden"
            aria-hidden="true"
            data-testid="form-planning"
          >
            Choosing places, then checking every stop against opening hours and travel time.
          </p>
        ) : null}
        <button
          type="submit"
          className="primary-button"
          aria-disabled={planning}
          aria-busy={planning}
          data-testid="plan-button"
        >
          {planning ? "Planning your trip" : "Plan my trip"}
        </button>
      </div>
    </form>
  );
}
