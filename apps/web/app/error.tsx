"use client";

import { PageMessage } from "../components/PageMessage";

// Shown when the page itself crashes while rendering. The map and other optional parts have
// their own fallbacks, so reaching this means something the page cannot work without failed.
// Decision: one action, a full reload. A crash here usually comes from code that failed to load,
// and re-rendering without reloading would ask for the same failed file again. The last plan is
// saved on this device, so reloading does not lose it.

export default function ErrorPage() {
  return (
    <PageMessage
      title="This page stopped working."
      body="Reload to start it again. Your last plan is saved on this device and comes back after the reload."
    >
      <button
        type="button"
        className="primary-button max-w-xs"
        onClick={() => window.location.reload()}
        data-testid="error-reload"
      >
        Reload the page
      </button>
    </PageMessage>
  );
}
