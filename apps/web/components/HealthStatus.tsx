"use client";

import { useEffect, useState } from "react";
import { fetchHealth, type Health } from "../lib/api";

// Shows whether the web app can reach the API. Placeholder for the scaffold; the planner UI
// replaces it later.

export type HealthState =
  | { status: "loading" }
  | { status: "ok"; health: Health }
  | { status: "error"; message: string };

export function HealthStatus() {
  const [state, setState] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal).then(
      (health) => setState({ status: "ok", health }),
      (error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        setState({ status: "error", message });
      },
    );
    return () => controller.abort();
  }, []);

  return <HealthView state={state} />;
}

export function HealthView({ state }: { state: HealthState }) {
  return (
    <section
      aria-live="polite"
      className="rounded border border-rule px-4 py-3"
      data-status={state.status}
    >
      <h2 className="mb-1 text-sm font-semibold">API status</h2>
      <HealthMessage state={state} />
    </section>
  );
}

function HealthMessage({ state }: { state: HealthState }) {
  if (state.status === "loading") {
    return <p>Checking the API</p>;
  }
  if (state.status === "error") {
    return (
      <p className="text-signal">
        API not reachable ({state.message}). Start it with pnpm dev and reload this page.
      </p>
    );
  }
  return (
    <p>
      API is up. Version {state.health.version}, commit {state.health.commit}.
    </p>
  );
}
