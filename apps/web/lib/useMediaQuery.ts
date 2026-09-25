"use client";

import { useCallback, useSyncExternalStore } from "react";

// Whether a media query matches now, updated live. False on the server and where the browser
// has no matchMedia (the unit tests), which is the phone layout.

function list(query: string): MediaQueryList | undefined {
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const media = list(query);
      media?.addEventListener?.("change", notify);
      return () => media?.removeEventListener?.("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => list(query)?.matches === true,
    () => false,
  );
}
