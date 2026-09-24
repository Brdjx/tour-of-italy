"use client";

import { useEffect, useState } from "react";
import { type PendingUpdate, startServiceWorker } from "../lib/sw/register";

// Registers the service worker (production builds only) and, when a new version has installed
// and is waiting, offers to reload into it. The strip sits in the page flow under the header,
// so it never covers the plan, the sheet, the toast, or the sticky "Plan my trip" button.

interface UpdatePromptProps {
  start?: typeof startServiceWorker; // injected in tests
}

export function UpdatePrompt({ start = startServiceWorker }: UpdatePromptProps) {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);

  useEffect(() => start(setUpdate), [start]);

  // The status wrapper is always in the page, so screen readers announce the text when it
  // appears.
  return (
    <div role="status" data-testid="update-status">
      {update ? (
        <div className="app-notice app-notice--update" data-testid="update-prompt">
          <p className="min-w-0 flex-1">A new version is available.</p>
          <button
            type="button"
            className="toolbar-button"
            onClick={() => update.apply()}
            data-testid="update-reload"
          >
            Reload
          </button>
        </div>
      ) : null}
    </div>
  );
}
