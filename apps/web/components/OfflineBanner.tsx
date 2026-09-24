"use client";

import { useSyncExternalStore } from "react";

// Says when the device is offline. Plans still work once the places are on this device: the page
// plans in the browser with the same rules, and the plan is labelled "Planned without AI,
// offline". Without the places it says so instead of promising a plan it cannot make.

export const OFFLINE_CAN_PLAN = "You are offline. New plans are made on this device, without AI.";
export const OFFLINE_NO_PLACES =
  "You are offline, and the places are not saved on this device yet. Connect to plan a trip.";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

// Decision: the static HTML is built as "online", so the first paint matches the server
// render; the real state takes over right after hydration.
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

export function OfflineBanner({ canPlan }: { canPlan: boolean }) {
  const online = useOnline();
  return (
    <div role="status" data-testid="offline-status">
      {online ? null : (
        <p className="app-notice app-notice--offline" data-testid="offline-banner">
          <span className="offline-dot" aria-hidden="true" />
          <span className="min-w-0 flex-1">{canPlan ? OFFLINE_CAN_PLAN : OFFLINE_NO_PLACES}</span>
        </p>
      )}
    </div>
  );
}
