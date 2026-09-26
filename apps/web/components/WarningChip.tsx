"use client";

import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { afterPress, trackPointer } from "../lib/afterPress";
import type { Chip } from "../lib/chips";
import { ChevronIcon } from "./icons";
import { ROUTE_SHEET_ID } from "./RouteSheet";

// One chip component for every data note, plan warning and flagged error. The explanation opens
// on tap or click and on keyboard focus, never on hover alone, and it is also wired as the
// button's description so a screen reader hears it on focus. It renders inline under the row of
// chips (not as a floating popover), so it can never push the page wider than the screen. A day's
// missing meal can list the places it is about under its words, and offer its way out as a
// control there: another city for the day (the route sheet, as the city on the day's line opens).

// Square chips, Goodpix style: a quiet hairline for notes, the caution fill for warnings, and a
// danger hairline with danger text for problems (danger never fills).
const TONE_CLASS: Record<Chip["tone"], string> = {
  note: "chip--note",
  warning: "chip--warning",
  error: "chip--error",
};

/** The city on the day's line, for a chip whose way out is another city for the day. */
export interface ChipCityControl {
  onOpen: () => void;
  disabled: boolean; // days are being planned again
}

interface WarningChipProps {
  chip: Chip;
  open: boolean;
  id: string;
  explanationId: string; // the explanation's words: the chip's description
  panelId: string; // what opens: the words, and a meal's places and way out
  onOpenChange: (open: boolean) => void;
}

/** True when `target` is inside the element with id `id`. */
function inside(id: string, target: EventTarget | null): boolean {
  return target instanceof Node && document.getElementById(id)?.contains(target) === true;
}

/** The control in an open explanation, when it has one. */
function panelControl(panelId: string): HTMLElement | null {
  return document.getElementById(panelId)?.querySelector<HTMLElement>(".chip-action") ?? null;
}

export function WarningChip({
  chip,
  open,
  id,
  explanationId,
  panelId,
  onOpenChange,
}: WarningChipProps) {
  // Pointer presses open the chip on click; keyboard focus opens it on focus. Tracking the
  // pointer keeps a mouse press from opening on focus and then closing again on click.
  const pointer = useRef(false);
  return (
    <button
      type="button"
      id={id}
      className="chip-button group"
      aria-expanded={open}
      aria-controls={panelId}
      aria-describedby={explanationId}
      data-tone={chip.tone}
      data-testid="warning-chip"
      onPointerDown={() => {
        pointer.current = true;
      }}
      onFocus={() => {
        if (!pointer.current) onOpenChange(true);
      }}
      onBlur={(event: FocusEvent<HTMLButtonElement>) => {
        pointer.current = false;
        // Into its own explanation's control, the explanation stays open.
        if (inside(panelId, event.relatedTarget)) return;
        // Closing moves the content below up; wait until a press elsewhere has clicked.
        afterPress(() => onOpenChange(false));
      }}
      onClick={() => {
        pointer.current = false;
        onOpenChange(!open);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          onOpenChange(false);
        }
        // Decision: Tab goes from the chip into its open explanation's control, then on to the
        // next chip. The explanations sit under the whole row, after every chip, so the browser's
        // own order would pass the next chip first and close this explanation on the way.
        if (event.key === "Tab" && !event.shiftKey && open) {
          const control = panelControl(panelId);
          if (control) {
            event.preventDefault();
            control.focus();
          }
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
export function WarningChips({
  chips,
  city,
}: {
  chips: readonly Chip[];
  city?: ChipCityControl; // the day's city, for a chip whose way out is another city
}) {
  const baseId = useId();
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => trackPointer(), []);
  if (chips.length === 0) return null;
  const setOpen = (key: string, open: boolean) =>
    setOpenKey((current) => (open ? key : current === key ? null : current));
  return (
    <div className="chips">
      <ul className="flex flex-wrap gap-x-1.5" aria-label="Notes">
        {chips.map((chip, index) => (
          <li key={chip.key}>
            <WarningChip
              chip={chip}
              open={openKey === chip.key}
              id={`${baseId}-chip-${index}`}
              explanationId={describedBy(chip, `${baseId}-${index}`, city)}
              panelId={hasPanel(chip) ? `${baseId}-panel-${index}` : `${baseId}-${index}`}
              onOpenChange={(open) => setOpen(chip.key, open)}
            />
          </li>
        ))}
      </ul>
      {chips.map((chip, index) =>
        hasPanel(chip) ? (
          <ExplanationPanel
            key={chip.key}
            chip={chip}
            id={`${baseId}-${index}`}
            panelId={`${baseId}-panel-${index}`}
            chipId={`${baseId}-chip-${index}`}
            nextChipId={index + 1 < chips.length ? `${baseId}-chip-${index + 1}` : null}
            open={openKey === chip.key}
            city={city}
            onClose={() => setOpen(chip.key, false)}
          />
        ) : (
          <p
            key={chip.key}
            id={`${baseId}-${index}`}
            hidden={openKey !== chip.key}
            className="chip-explanation"
            data-testid="chip-explanation"
          >
            {chip.explanation}
          </p>
        ),
      )}
    </div>
  );
}

/** An explanation with more than words: places, or a way out. */
function hasPanel(chip: Chip): boolean {
  return (chip.places?.length ?? 0) > 0 || chip.wayOut !== undefined || chip.action !== undefined;
}

/** The chip's control in its explanation: another city, when the day's city can be changed. */
function actionShown(chip: Chip, city: ChipCityControl | undefined): boolean {
  return chip.action === "city" && city !== undefined;
}

/** The ids that describe a chip: its words, and its way out when that is words of its own. */
function describedBy(chip: Chip, id: string, city: ChipCityControl | undefined): string {
  return chip.wayOut && !actionShown(chip, city) ? `${id} ${id}-way-out` : id;
}

/**
 * A chip's explanation with its places and its way out. The way out is words under the places, or
 * the control that does it; then the words go to screen readers only, in the chip's description.
 */
function ExplanationPanel(props: {
  chip: Chip;
  id: string; // the words, which describe the chip
  panelId: string;
  chipId: string;
  nextChipId: string | null;
  open: boolean;
  city: ChipCityControl | undefined;
  onClose: () => void;
}) {
  const { chip, id, city } = props;
  const control = actionShown(chip, city);
  return (
    <div
      id={props.panelId}
      hidden={!props.open}
      className="chip-explanation"
      data-testid="chip-explanation"
    >
      <p id={id}>
        {chip.explanation}
        {chip.wayOut && control ? <span className="sr-only"> {chip.wayOut}</span> : null}
      </p>
      {chip.places && chip.places.length > 0 ? (
        <ul className="chip-places" aria-label="Places" data-testid="chip-places">
          {chip.places.map((place) => (
            <li key={place.name} className="chip-place">
              <span className="chip-place-name">{place.name}</span>
              {place.why ? <span className="chip-place-why">: {place.why}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {chip.wayOut && !control ? (
        <p id={`${id}-way-out`} className="chip-way-out">
          {chip.wayOut}
        </p>
      ) : null}
      {control && city ? (
        <CityAction
          city={city}
          chipId={props.chipId}
          nextChipId={props.nextChipId}
          onClose={props.onClose}
        />
      ) : null}
    </div>
  );
}

/**
 * "Choose another city": the chip's way out, which opens the route sheet on the day's cities as
 * the city on the day's line does. Shift+Tab goes back to its chip and Tab on to the next chip.
 */
function CityAction(props: {
  city: ChipCityControl;
  chipId: string;
  nextChipId: string | null;
  onClose: () => void;
}) {
  const { city, chipId, nextChipId, onClose } = props;
  const focusChip = (chip: string | null) => {
    const target = chip ? document.getElementById(chip) : null;
    target?.focus();
    return target !== null;
  };
  return (
    <button
      type="button"
      className="pill pill--line chip-action"
      onClick={city.disabled ? undefined : city.onOpen}
      aria-haspopup="dialog"
      aria-controls={ROUTE_SHEET_ID}
      aria-disabled={city.disabled || undefined}
      data-testid="chip-city"
      onBlur={(event: FocusEvent<HTMLButtonElement>) => {
        // Back to its chip, the explanation stays open.
        if (event.relatedTarget === document.getElementById(chipId)) return;
        afterPress(onClose);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          focusChip(chipId);
          onClose();
        } else if (event.key === "Tab" && event.shiftKey) {
          if (focusChip(chipId)) event.preventDefault();
        } else if (event.key === "Tab" && focusChip(nextChipId)) {
          event.preventDefault();
        }
      }}
    >
      Choose another city
      <ChevronIcon size={16} className="chip-action-chevron" />
    </button>
  );
}
