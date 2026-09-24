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
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-toast-accent outline-none focus-visible:ring-2 focus-visible:ring-toast-focus"
          data-testid="toast-undo"
        >
          <UndoIcon size={18} />
          {undoLabel}
        </button>
      ) : null}
    </div>
  );
}
