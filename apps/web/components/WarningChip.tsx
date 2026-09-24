"use client";

import { useEffect, useId, useRef, useState } from "react";
import { afterPress, trackPointer } from "../lib/afterPress";
import type { Chip } from "../lib/chips";

// One chip component for every data note, plan warning and flagged error. The explanation opens
// on tap or click and on keyboard focus, never on hover alone, and it is also wired as the
// button's description so a screen reader hears it on focus. It renders inline under the row of
// chips (not as a floating popover), so it can never push the page wider than the screen.

const TONE_CLASS: Record<Chip["tone"], string> = {
  note: "border-line text-muted",
  warning: "border-warn bg-warn text-warn-fg",
  error: "border-danger bg-danger-soft text-danger",
};

interface WarningChipProps {
  chip: Chip;
  open: boolean;
  explanationId: string;
  onOpenChange: (open: boolean) => void;
}

export function WarningChip({ chip, open, explanationId, onOpenChange }: WarningChipProps) {
  // Pointer presses open the chip on click; keyboard focus opens it on focus. Tracking the
  // pointer keeps a mouse press from opening on focus and then closing again on click.
  const pointer = useRef(false);
  return (
    <button
      type="button"
      className="group inline-flex min-h-11 items-center rounded-full outline-none"
      aria-expanded={open}
      aria-controls={explanationId}
      aria-describedby={explanationId}
      data-tone={chip.tone}
      data-testid="warning-chip"
      onPointerDown={() => {
        pointer.current = true;
      }}
      onFocus={() => {
        if (!pointer.current) onOpenChange(true);
      }}
      onBlur={() => {
        pointer.current = false;
        // Closing moves the content below up; wait until a press elsewhere has clicked.
        afterPress(() => onOpenChange(false));
      }}
      onClick={() => {
        pointer.current = false;
        onOpenChange(!open);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <span
        className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-sm leading-tight group-focus-visible:ring-2 group-focus-visible:ring-focus group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-page ${TONE_CLASS[chip.tone]}`}
      >
        {chip.tone === "error" ? <span className="sr-only">Problem: </span> : null}
        {chip.label}
      </span>
    </button>
  );
}

/** A row of chips with one shared explanation area underneath. */
export function WarningChips({ chips }: { chips: readonly Chip[] }) {
  const baseId = useId();
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => trackPointer(), []);
  if (chips.length === 0) return null;
  return (
    <div className="mt-1">
      <ul className="flex flex-wrap gap-x-1.5" aria-label="Notes">
        {chips.map((chip, index) => (
          <li key={chip.key}>
            <WarningChip
              chip={chip}
              open={openKey === chip.key}
              explanationId={`${baseId}-${index}`}
              onOpenChange={(open) =>
                setOpenKey((current) => (open ? chip.key : current === chip.key ? null : current))
              }
            />
          </li>
        ))}
      </ul>
      {chips.map((chip, index) => (
        <p
          key={chip.key}
          id={`${baseId}-${index}`}
          hidden={openKey !== chip.key}
          className="mt-1 max-w-prose border-l-2 border-line pl-3 text-sm text-fg"
          data-testid="chip-explanation"
        >
          {chip.explanation}
        </p>
      ))}
    </div>
  );
}
