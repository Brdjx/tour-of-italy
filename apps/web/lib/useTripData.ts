"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadTripData as defaultLoader, type TripData } from "./tripData";

// React state around loadTripData: loading, ready, or error, with a retry that starts over.

export type TripDataState =
  | { status: "loading" }
  | { status: "ready"; data: TripData }
  | { status: "error"; error: unknown };

export type TripDataLoader = (signal: AbortSignal) => Promise<TripData>;

export function useTripData(loader: TripDataLoader = defaultLoader) {
  const [state, setState] = useState<TripDataState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Decision: the loader is read through a ref, so a caller passing a new function on every
  // render cannot restart the load in a loop. Only mount and retry start a load.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    // `attempt` is read so a retry re-runs this effect.
    void attempt;
    const controller = new AbortController();
    setState({ status: "loading" });
    loaderRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}
