"use client";

import { useEffect, useId, useRef, useState } from "react";
import { afterPress, trackPointer } from "../lib/afterPress";
import type { Chip } from "../lib/chips";

// One chip component for every data note, plan warning and flagged error. The explanation opens
// on tap or click and on keyboard focus, never on hover alone, and it is also wired as the
// button's description so a screen reader hears it on focus. It renders inline under the row of
// chips (not as a floating popover), so it can never push the page wider than the screen.

// Square chips, Goodpix style: a quiet hairline for notes, the caution fill for warnings, and a
// danger hairline with danger text for problems (danger never fills).
const TONE_CLASS: Record<Chip["tone"], string> = {
  note: "chip--note",
  warning: "chip--warning",
  error: "chip--error",
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
      className="chip-button group"
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
      <span className={`chip ${TONE_CLASS[chip.tone]}`}>
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
    <div className="chips">
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
          className="chip-explanation"
          data-testid="chip-explanation"
        >
          {chip.explanation}
        </p>
      ))}
    </div>
  );
}
