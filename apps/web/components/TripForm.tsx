"use client";

import type { TripRequest } from "@italy/planner";
import {
  type FocusEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { keepClearOfActions } from "../lib/keepClear";
import { clearOptions, optionCount } from "../lib/moreOptions";
import {
  type FormErrors,
  type FormField,
  hasErrors,
  type TripFormValues,
  toggleValue,
  toTripRequest,
  validateTripForm,
} from "../lib/tripForm";
import { PRIMARY_OPTIONS, type TripOptions } from "../lib/tripOptions";
import { SLOW_PLAN_TEXT } from "../lib/usePlanTrip";
import { MoreOptions } from "./form/MoreOptions";
import { type DataStatus, OptionFields } from "./form/OptionFields";
import { PrimaryControls } from "./form/PrimaryControls";

// The trip form: start date and pace always on screen, everything else in the "More options"
// sheet, then "Plan my trip". Date, pace and the button need no data, so they work from the
// first paint; the options that are built from the places show skeletons until they arrive.
// Checks run on submit with one message per field; the first problem gets focus, and an error
// inside the options opens their sheet first. The request that leaves here has passed the
// planner's own TripRequestSchema. The form sits on the page before any plan and in the Edit
// trip sheet after one (TripPane).

interface TripFormProps {
  options: TripOptions | null; // null until the places load
  dataStatus?: DataStatus; // defaults to "ready" with options, "loading" without
  onRetryData?: () => void;
  initialValues: TripFormValues;
  planning: boolean;
  slow?: boolean; // the plan in flight has passed SLOW_PLAN_MS
  onSubmit: (request: TripRequest) => void;
  beforeActions?: ReactNode; // shown above "Plan my trip" (the Edit trip sheet's reset)
}

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

/** Fields inside "More options": an error on one of them opens the sheet. */
const OPTION_FIELDS: readonly FormField[] = [
  "interests",
  "anchors",
  "mustInclude",
  "exclude",
  "notes",
];

export function TripForm(props: TripFormProps) {
  const { options, initialValues, planning, onSubmit } = props;
  const status: DataStatus = props.dataStatus ?? (options ? "ready" : "loading");
  const id = useId();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FormErrors>({});
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [focusField, setFocusField] = useState<FormField | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const primary = options ?? PRIMARY_OPTIONS;
  const count = optionCount(values);

  // Focus moves after the render that opened the sheet, so the field is visible when it lands.
  // The option fields live in the sheet, outside the <form> element (Sheet portals to <body>).
  useEffect(() => {
    if (!focusField) return;
    const selector = FOCUS_TARGET[focusField];
    const target =
      formRef.current?.querySelector<HTMLElement>(selector) ??
      panelRef.current?.querySelector<HTMLElement>(selector);
    target?.focus();
    setFocusField(null);
  }, [focusField]);

  const set = <K extends keyof TripFormValues>(key: K, value: TripFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const toggle = (key: "interests" | "anchors", value: string, max: number) =>
    setValues((current) => ({ ...current, [key]: toggleValue(current[key], value, max) }));

  const clear = () => {
    setValues(clearOptions);
    setErrors((current) => (current.startDate ? { startDate: current.startDate } : {}));
  };

  // Decision: only for fields on the page. In a sheet, the sheet's own scroller keeps the field
  // clear of the bar (sheet.css), and scrolling the window would move the page behind it.
  const onFocus = (event: FocusEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    if (form.closest("dialog") || !(event.target instanceof Node) || !form.contains(event.target)) {
      return;
    }
    keepClearOfActions(event);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (planning) return;
    const found = validateTripForm(values, primary.limits);
    const request = hasErrors(found) ? null : toTripRequest(values);
    const next: FormErrors = hasErrors(found) || request ? found : { form: "Check the form." };
    setErrors(next);
    const first = Object.keys(next)[0] as FormField | undefined;
    if (first) {
      if (OPTION_FIELDS.includes(first)) setOptionsOpen(true);
      setFocusField(first);
      return;
    }
    if (request) onSubmit(request);
  };

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      onFocus={onFocus}
      className="trip-form"
      data-testid="trip-form"
      aria-label="Your trip"
    >
      <PrimaryControls
        options={primary}
        values={values}
        errors={errors}
        onDate={(value) => set("startDate", value)}
        onPace={(value) => set("pace", value)}
      />
      <MoreOptions
        open={optionsOpen}
        onOpen={() => setOptionsOpen(true)}
        onClose={() => setOptionsOpen(false)}
        count={count}
        status={status}
        onRetryData={props.onRetryData}
        onClear={clear}
        buttonRef={moreRef}
        panelRef={panelRef}
      >
        <OptionFields
          idBase={id}
          status={status}
          options={options}
          limits={primary.limits}
          values={values}
          errors={errors}
          set={set}
          toggle={toggle}
        />
      </MoreOptions>
      {props.beforeActions}
      <div className="form-actions">
        {errors.form ? <p className="field-error mb-2">{errors.form}</p> : null}
        {planning ? (
          // Seen when the form is open while a plan is on its way; the plan's skeleton says the
          // same further down. The live region announces it, so it is hidden from screen readers.
          <p className="mb-2 text-sm text-muted" aria-hidden="true" data-testid="form-planning">
            {props.slow
              ? SLOW_PLAN_TEXT
              : "Choosing places, then checking every stop against opening hours and travel time."}
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
