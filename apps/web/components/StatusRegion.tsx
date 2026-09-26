"use client";

import { useEffect, useState } from "react";
import { UndoIcon } from "./icons";

// Status for everyone: a visually hidden polite live region that screen readers announce, and a
// short-lived toast at the bottom of the screen (above the home indicator) for sighted users,
// with Undo when the message is about an edit.

/** How long the toast stays up. */
export const TOAST_MS = 5000;

interface LiveRegionProps {
  message: string | null;
  serial: number; // a new number announces the message again, even when the text repeats
}

export function LiveRegion({ message, serial }: LiveRegionProps) {
  // Decision: each message is a new child node keyed by its serial. Screen readers announce
  // added nodes, so "Moved Pantheon down." said twice is heard twice; text that stays the same
  // in one node would be announced once. data-live-region keeps it out of the swap sheet's
  // inert background, so an announcement made as the sheet closes is not lost.
  return (
    <div
      role="status"
      aria-live="polite"
      className="sr-only"
      data-testid="live-region"
      data-live-region=""
    >
      {message ? <p key={serial}>{message}</p> : null}
    </div>
  );
}

interface ToastProps {
  message: string | null;
  serial: number; // a new number restarts the toast even when the text repeats
  undoLabel: string | null;
  onUndo: () => void;
}

// Decision: Undo says only "Undo" on phones, as the header's Undo does, and keeps its full words
// as its name for screen readers and voice control. "Undo route change" took half of a 390 px
// toast and squeezed a route's message into five lines over the board (design review,
// 2026-09-26); from 640 px the toast is its full 560 px and has room for the words.
const WIDE_WORDS = "max-sm:sr-only";

export function Toast({ message, serial, undoLabel, onUndo }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // `serial` is read so the same message shown twice restarts the timer.
    void serial;
    if (!message) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, serial]);

  if (!visible || !message) return null;
  const [verb, ...rest] = (undoLabel ?? "").split(" ");
  // aria-hidden: the live region already announces this text; the toast is the visual echo.
  return (
    <div className="toast" data-testid="toast">
      <p className="min-w-0 flex-1 text-sm" aria-hidden="true">
        {message}
      </p>
      {undoLabel ? (
        <button
          type="button"
          onClick={() => {
            setVisible(false);
            onUndo();
          }}
          className="toast-undo"
          data-testid="toast-undo"
        >
          <UndoIcon size={18} />
          <span>
            {verb}
            {rest.length > 0 ? <span className={WIDE_WORDS}> {rest.join(" ")}</span> : null}
          </span>
        </button>
      ) : null}
    </div>
  );
}
