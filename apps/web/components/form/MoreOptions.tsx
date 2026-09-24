"use client";

import { type ReactNode, type Ref, useId } from "react";
import { moreOptionsName, setBadgeText } from "../../lib/moreOptions";
import { ChevronIcon } from "../icons";
import type { DataStatus } from "./OptionFields";

// "More options": a disclosure button that folds the filters away until the traveler wants
// them. It opens inline, the same on every screen, with no dialog. When any option is set the
// button says how many, in a badge that is also part of its name ("More options, 2 set"). If
// the data behind the options could not load, a short message with Try again sits under the
// button, visible even while the panel is closed.

interface MoreOptionsProps {
  open: boolean;
  onToggle: () => void;
  count: number;
  status: DataStatus;
  onRetryData?: () => void;
  onClear: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

export const OPTIONS_FAILED =
  "Interests and places could not load. You can still plan with the date and pace.";

export function MoreOptions(props: MoreOptionsProps) {
  const { open, onToggle, count, status, onRetryData, onClear, buttonRef, children } = props;
  const panelId = useId();
  const badge = setBadgeText(count);
  return (
    <div className="more-options" data-testid="more-options">
      <button
        ref={buttonRef}
        type="button"
        className="more-options-button"
        aria-expanded={open}
        aria-controls={panelId}
        // Decision: an explicit name, "More options, 2 set". Built from the visible words, so
        // speech input ("click More options") still matches it.
        aria-label={moreOptionsName(count)}
        onClick={onToggle}
        data-testid="more-options-button"
      >
        <span className="more-options-label">More options</span>
        {badge ? (
          <span className="count-badge" data-testid="options-count">
            {badge}
          </span>
        ) : null}
        <ChevronIcon
          size={20}
          className={`more-options-chevron${open ? " more-options-chevron--open" : ""}`}
        />
      </button>
      {status === "error" ? (
        <div className="options-error" role="alert" data-testid="options-error">
          <p className="min-w-0 flex-1">{OPTIONS_FAILED}</p>
          {onRetryData ? (
            <button
              type="button"
              className="text-button"
              onClick={onRetryData}
              data-testid="options-retry"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        id={panelId}
        hidden={!open}
        className="more-options-panel"
        aria-busy={status === "loading" ? true : undefined}
        data-testid="more-options-panel"
      >
        {children}
        {count > 0 ? (
          <button
            type="button"
            className="text-button clear-options"
            onClick={onClear}
            data-testid="clear-options"
          >
            Clear options
          </button>
        ) : null}
      </div>
    </div>
  );
}
