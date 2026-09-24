import type { FocusEvent } from "react";

/**
 * Scrolls a focused field out from under the form's sticky "Plan my trip" bar. Chromium does
 * this from html's scroll-padding; WebKit leaves a partly covered field (the notes box on an
 * iPhone SE) where it is. Attach as the form's onFocus (React's focus events bubble).
 */
export function keepClearOfActions(event: FocusEvent<HTMLElement>): void {
  const bar = event.currentTarget.querySelector(".form-actions");
  const field = event.target;
  if (!bar || !(field instanceof HTMLElement) || bar.contains(field)) return;
  const overlap = field.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
  if (overlap > 0) window.scrollBy({ top: overlap + 12 });
}
