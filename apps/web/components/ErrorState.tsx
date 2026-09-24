"use client";

import { CloseIcon } from "./icons";

// Error and notice banners. An error says what went wrong and what to do next, never
// apologizes, and sits above the previous plan instead of replacing it.

interface ErrorStateProps {
  id?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ id, message, onRetry, retryLabel = "Try again" }: ErrorStateProps) {
  return (
    <div id={id} role="alert" className="banner banner--error" data-testid="error-state">
      <p className="min-w-0 flex-1 text-base">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="banner-button"
          data-testid="retry-button"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

interface NoticeProps {
  message: string;
  onDismiss: () => void;
  testId?: string;
}

/** A neutral note, such as what happened while opening a shared link. */
export function Notice({ message, onDismiss, testId = "notice" }: NoticeProps) {
  return (
    <div className="banner banner--note" data-testid={testId}>
      <p className="min-w-0 flex-1 text-base">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
        aria-label="Dismiss note"
      >
        <CloseIcon size={18} />
      </button>
    </div>
  );
}
