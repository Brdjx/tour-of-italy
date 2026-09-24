"use client";

import type { PriceLevel } from "@italy/planner";
import type { AnchorMode, FormErrors, TripFormValues } from "../../lib/tripForm";
import type { TripLimits, TripOptions } from "../../lib/tripOptions";
import { SkeletonChips, SkeletonField } from "../skeleton/Skeleton";
import { ChipChoices } from "./ChipChoices";
import { InterestField } from "./InterestField";
import { NotesField } from "./NotesField";
import { PlacePicker } from "./PlacePicker";
import { type Segment, SegmentedField } from "./SegmentedField";

// The fields inside "More options": interests, budget, where to stay, must see, places to avoid,
// and notes for the AI planner. Budget and notes need no data. The others are built from the
// places: skeletons while they load, and left out when they could not load (the panel then says
// so, with Try again), so planning with the date and pace still works.

export type DataStatus = "loading" | "ready" | "error";

type Budget = "any" | "1" | "2" | "3" | "4";
type SetValue = <K extends keyof TripFormValues>(key: K, value: TripFormValues[K]) => void;

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

interface OptionFieldsProps {
  idBase: string;
  status: DataStatus;
  options: TripOptions | null; // null until the places load
  limits: TripLimits;
  values: TripFormValues;
  errors: FormErrors;
  set: SetValue;
  toggle: (key: "interests" | "anchors", value: string, max: number) => void;
}

export function OptionFields(props: OptionFieldsProps) {
  const { idBase, status, options, limits, values, errors, set, toggle } = props;
  const withData = status !== "error";
  return (
    <div className="option-fields">
      {withData ? (
        <div data-field="interests">
          <InterestField
            interests={options?.interests ?? null}
            selected={values.interests}
            max={limits.maxInterests}
            onToggle={(tag) => toggle("interests", tag, limits.maxInterests)}
            error={errors.interests}
            errorId={`${idBase}-interests-error`}
          />
        </div>
      ) : null}
      <SegmentedField<Budget>
        legend="Budget"
        name={`${idBase}-budget`}
        segments={BUDGETS}
        value={values.maxPriceLevel === null ? "any" : (String(values.maxPriceLevel) as Budget)}
        onChange={(value) =>
          set("maxPriceLevel", value === "any" ? null : (Number(value) as PriceLevel))
        }
        hint="The most you want to spend at any one place."
        testId="budget-field"
      />
      {withData ? <WhereToStay {...props} /> : null}
      {withData ? <PlaceFields {...props} /> : null}
      <div data-field="notes">
        <NotesField
          value={values.notes}
          max={limits.notesMaxChars}
          onChange={(value) => set("notes", value)}
          error={errors.notes}
        />
      </div>
    </div>
  );
}

function WhereToStay({ idBase, options, limits, values, errors, set, toggle }: OptionFieldsProps) {
  const hint = `Up to ${limits.maxAnchors}. Nearby towns are day trips from their base.`;
  return (
    <div data-field="anchors" className="space-y-1">
      <SegmentedField<AnchorMode>
        legend="Where to stay"
        name={`${idBase}-anchor-mode`}
        segments={ANCHOR_MODES}
        value={values.anchorMode}
        onChange={(value) => set("anchorMode", value)}
        testId="anchor-mode-field"
      />
      {values.anchorMode !== "choose" ? null : options ? (
        <ChipChoices
          legend="Bases"
          choices={options.anchors.map((anchor) => ({
            value: anchor.id,
            label: anchor.name,
            count: anchor.placeCount,
          }))}
          selected={values.anchors}
          max={limits.maxAnchors}
          onToggle={(anchor) => toggle("anchors", anchor, limits.maxAnchors)}
          hint={hint}
          error={errors.anchors}
          errorId={`${idBase}-anchors-error`}
          testId="anchors-field"
        />
      ) : (
        <fieldset className="field" aria-busy="true" data-testid="anchors-field">
          <legend className="field-label">Bases</legend>
          <SkeletonChips count={5} testId="anchors-skeleton" />
          <p className="field-hint">{hint}</p>
        </fieldset>
      )}
    </div>
  );
}

function PlaceFields({ options, limits, values, errors, set }: OptionFieldsProps) {
  const mustHint = `Up to ${limits.maxMustInclude}. The plan includes them when they are open.`;
  const avoidHint = `Up to ${limits.maxExclude}. The plan never includes them.`;
  if (!options) {
    return (
      <>
        <LoadingPicker label="Must see" hint={mustHint} testId="must-see-field" />
        <LoadingPicker label="Avoid" hint={avoidHint} testId="skip-field" />
      </>
    );
  }
  return (
    <>
      <div data-field="mustInclude">
        <PlacePicker
          label="Must see"
          listName="must see"
          hint={mustHint}
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
          label="Avoid"
          listName="places to avoid"
          hint={avoidHint}
          places={options.places}
          selected={values.exclude}
          blocked={values.mustInclude}
          max={limits.maxExclude}
          onChange={(ids) => set("exclude", ids)}
          error={errors.exclude}
          testId="skip-field"
        />
      </div>
    </>
  );
}

/** A place search that is still loading: its label and hint, and a field-shaped skeleton. */
function LoadingPicker({ label, hint, testId }: { label: string; hint: string; testId: string }) {
  return (
    <div className="field" aria-busy="true" data-testid={testId}>
      <p className="field-label">{label}</p>
      <SkeletonField testId={`${testId}-skeleton`} />
      <p className="field-hint">{hint}</p>
    </div>
  );
}
