"use client";

import { type ReactNode, type RefObject, useId, useRef } from "react";
import { moreOptionsName, setBadgeText } from "../../lib/moreOptions";
import { ChevronIcon } from "../icons";
import { Sheet } from "../Sheet";
import type { DataStatus } from "./OptionFields";

// "More options": a row that opens the filters in a sheet, the Apple way: a bottom sheet with a
// grabber on phones and a centred sheet from 768 px, over the blurred page (or stacked over the
// Edit trip sheet). The sheet has Done and, once anything is set, Clear options. When any
// option is set the row says how many, in a badge that is also part of its name ("More
// options, 2 set"). If the data behind the options could not load, a short message with Try
// again sits under the row, visible while the sheet is closed.

interface MoreOptionsProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  count: number;
  status: DataStatus;
  onRetryData?: () => void;
  onClear: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>; // where the fields are, for focusing one
  children: ReactNode;
}

export const OPTIONS_FAILED =
  "Interests and places could not load. You can still plan with the date and pace.";

export function MoreOptions(props: MoreOptionsProps) {
  const { open, onOpen, onClose, count, status, onRetryData, onClear, buttonRef } = props;
  const sheetId = useId();
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const badge = setBadgeText(count);

  const clear = () => {
    onClear();
    // The Clear button goes away with the last option; Done is the next thing to press.
    doneRef.current?.focus();
  };

  return (
    <div className="more-options" data-testid="more-options">
      <button
        ref={buttonRef}
        type="button"
        className="more-options-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={sheetId}
        // Decision: an explicit name, "More options, 2 set". Built from the visible words, so
        // speech input ("click More options") still matches it.
        aria-label={moreOptionsName(count)}
        onClick={onOpen}
        data-testid="more-options-button"
      >
        <span className="more-options-label">More options</span>
        {badge ? (
          <span className="count-badge" data-testid="options-count">
            {badge}
          </span>
        ) : null}
        <ChevronIcon size={20} className="more-options-chevron" />
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
      <Sheet
        open={open}
        onClose={onClose}
        id={sheetId}
        labelledBy={titleId}
        size="fit"
        className="options-sheet"
        testId="more-options-sheet"
        initialFocus={headingRef}
        returnFocus={buttonRef}
        header={
          <>
            <h2
              id={titleId}
              ref={headingRef}
              tabIndex={-1}
              className="form-sheet-title t-title outline-none"
            >
              More options
            </h2>
            <div className="form-sheet-actions">
              {count > 0 ? (
                <button
                  type="button"
                  className="pill pill--quiet"
                  onClick={clear}
                  data-testid="clear-options"
                >
                  Clear options
                </button>
              ) : null}
              <button
                ref={doneRef}
                type="button"
                className="pill pill--fill"
                onClick={onClose}
                data-testid="more-options-done"
              >
                Done
              </button>
            </div>
          </>
        }
      >
        <div
          ref={props.panelRef}
          className="more-options-panel"
          aria-busy={status === "loading" ? true : undefined}
          data-testid="more-options-panel"
        >
          {props.children}
        </div>
      </Sheet>
    </div>
  );
}
