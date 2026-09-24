"use client";

import { useId, useState } from "react";
import { INTERESTS_SHOWN, visibleInterests } from "../../lib/moreOptions";
import type { InterestOption } from "../../lib/tripOptions";
import { Skeleton, SkeletonChips } from "../skeleton/Skeleton";
import { ChipChoices } from "./ChipChoices";

// Interest chips: the most common few, with "Show all interests" for the rest. A picked
// interest always shows. While the interests load, chip-shaped skeletons hold their place.

interface InterestFieldProps {
  interests: readonly InterestOption[] | null; // null while the data loads
  selected: readonly string[];
  max: number;
  onToggle: (tag: string) => void;
  error?: string;
  errorId: string;
}

export function InterestField(props: InterestFieldProps) {
  const { interests, selected, max, onToggle, error, errorId } = props;
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const hint = `Pick up to ${max}. The number is how many places match.`;
  if (!interests) {
    return (
      <fieldset className="field" data-testid="interests-field" aria-busy="true">
        <legend className="field-label">Interests</legend>
        <SkeletonChips count={INTERESTS_SHOWN} testId="interests-skeleton" />
        <div className="text-button-slot" aria-hidden="true">
          <Skeleton width={136} height={12} />
        </div>
        <p className="field-hint">{hint}</p>
      </fieldset>
    );
  }
  const shown = visibleInterests(interests, selected, showAll);
  const toggle =
    interests.length > INTERESTS_SHOWN ? (
      <button
        type="button"
        className="text-button"
        aria-expanded={showAll}
        aria-controls={listId}
        onClick={() => setShowAll((value) => !value)}
        data-testid="show-all-interests"
      >
        {showAll ? "Show fewer interests" : "Show all interests"}
      </button>
    ) : null;
  return (
    <ChipChoices
      legend="Interests"
      choices={shown.map((item) => ({ value: item.tag, label: item.label, count: item.count }))}
      selected={selected}
      max={max}
      onToggle={onToggle}
      hint={hint}
      error={error}
      errorId={errorId}
      testId="interests-field"
      listId={listId}
      after={toggle}
    />
  );
}
