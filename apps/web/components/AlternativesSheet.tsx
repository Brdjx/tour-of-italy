"use client";

import { type Alternative, placeNotes } from "@italy/planner";
import { useEffect, useId, useRef } from "react";
import { clockDateTime, formatDuration, placeSubtitle } from "../lib/format";
import { displayReason } from "../lib/reasonText";
import { ClockText } from "./Clock";
import { CloseIcon } from "./icons";

// The swap picker: a modal sheet listing places that can replace a stop, each with the time it
// would take and why it fits. A bottom sheet on phones, a side sheet on wide screens. While it is
// open the rest of the page is inert, so focus and clicks cannot reach it; Escape closes it from
// anywhere, the backdrop closes it, and focus goes back where it came from.

export const EMPTY_ALTERNATIVES = "Nothing else fits this time slot. Try removing a stop first.";

interface AlternativesSheetProps {
  stopName: string;
  date: string;
  alternatives: readonly Alternative[];
  onChoose: (placeId: string) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null; // where focus goes on close; defaults to the opener
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex="0"]';

function focusableIn(container: HTMLElement | null): HTMLElement[] {
  return container ? [...container.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
}

/** Makes every sibling of `layer` inert except the live region; returns the undo. */
export function inertSiblings(layer: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (const sibling of layer.parentElement?.children ?? []) {
    if (sibling === layer || !(sibling instanceof HTMLElement)) continue;
    // The live region stays live: the edit made by choosing a place is announced as it closes.
    if (sibling.hasAttribute("data-live-region") || sibling.hasAttribute("inert")) continue;
    sibling.setAttribute("inert", "");
    changed.push(sibling);
  }
  return () => {
    for (const element of changed) element.removeAttribute("inert");
  };
}

export function AlternativesSheet(props: AlternativesSheetProps) {
  const { stopName, date, alternatives, onChoose, onClose, returnFocus } = props;
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const latest = useRef({ onClose, returnFocus });
  latest.current = { onClose, returnFocus };

  // Decision: a passive effect, so on close focus returns after the whole commit: a swap
  // replaces the row (and its Swap button) in the same commit that removes the sheet. Inert is
  // lifted first, since an inert element cannot take focus.
  useEffect(() => {
    const layer = layerRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreInert = layer ? inertSiblings(layer) : () => {};
    focusableIn(panelRef.current)[0]?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) =>
      trapKeys(event, panelRef.current, latest.current.onClose);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      restoreInert();
      const target = latest.current.returnFocus?.() ?? opener;
      if (target?.isConnected) target.focus();
    };
  }, []);

  return (
    <div className="sheet-layer" ref={layerRef}>
      <div className="sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Clicking text inside the sheet focuses the panel, not the page behind it.
        tabIndex={-1}
        className="sheet outline-none"
        data-testid="alternatives-sheet"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="pt-2 t-title text-fg [overflow-wrap:anywhere]">
            Swap {stopName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
            aria-label="Close"
            data-testid="alternatives-close"
          >
            <CloseIcon />
          </button>
        </div>
        {alternatives.length === 0 ? (
          <p className="mt-3 text-base text-fg" data-testid="alternatives-empty">
            {EMPTY_ALTERNATIVES}
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">
              Each choice keeps the rest of the day within opening hours. Times are for the new
              stop.
            </p>
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {alternatives.map((alternative) => (
                <li key={alternative.place.id}>
                  <Option alternative={alternative} date={date} onChoose={onChoose} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** Escape closes; Tab and Shift+Tab wrap inside the panel, also when focus sits on the page. */
function trapKeys(event: KeyboardEvent, panel: HTMLElement | null, onClose: () => void): void {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const items = focusableIn(panel);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  const outside = !panel?.contains(active) || active === panel;
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

function Option({
  alternative,
  date,
  onChoose,
}: {
  alternative: Alternative;
  date: string;
  onChoose: (placeId: string) => void;
}) {
  const { place, stop } = alternative;
  const notes = placeNotes(place).map((note) => note.label);
  // The sheet shows no rating, so only the type-and-area sentence is a repeat here.
  const reason = displayReason(stop.reason, stop.reasonSource === "ai", {
    place,
    role: stop.role,
    ratingShown: false,
  });
  return (
    <button
      type="button"
      className="block w-full py-3 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      onClick={() => onChoose(place.id)}
      data-testid="alternative-option"
    >
      <span className="block t-tab text-base text-fg">{place.name}</span>
      <span className="block text-sm text-muted">{placeSubtitle(place)}</span>
      <span className="mt-1 block text-sm text-fg">
        <time dateTime={clockDateTime(date, stop.start)} className="tabular">
          <ClockText minutes={stop.start} />
        </time>{" "}
        to{" "}
        <time dateTime={clockDateTime(date, stop.end)} className="tabular">
          <ClockText minutes={stop.end} />
        </time>
        , {formatDuration(stop.end - stop.start)}
      </span>
      {reason ? <span className="mt-1 block text-sm text-muted">{reason}</span> : null}
      {notes.length > 0 ? (
        <span className="mt-1 block text-sm text-muted">Note: {notes.join(", ")}</span>
      ) : null}
    </button>
  );
}
