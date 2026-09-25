"use client";

import type { PlannerContext } from "@italy/planner";
import { useCallback, useEffect, useRef } from "react";
import { decodeShare, readShareParam, SHARE_PARAM, type ShareDecode } from "./shareLink";

type OpenedLink = Exclude<ShareDecode, { status: "none" }>;

/** Removes one parameter from the address bar, keeping the rest and the history entry. */
export function dropParam(name: string): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", url.toString());
}

/**
 * Reads ?p= once, as soon as the places are loaded, hands the decoded result to `onOpen`, then
 * removes ?p= from the address bar so a reload does not reopen a plan the traveler has since
 * changed. Does nothing when there is no link.
 * Returns `drop`, which gives up a link that has not opened yet (the traveler planned a trip of
 * their own first): it never opens, ?p= goes, and drop says whether there was one.
 */
export function useSharedLinkOnLoad(
  ctx: PlannerContext | null,
  onOpen: (result: OpenedLink) => void,
): () => boolean {
  const handled = useRef(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!ctx || handled.current) return;
    handled.current = true;
    const param = readShareParam(window.location.search);
    const result = decodeShare(param, ctx, new Date().toISOString());
    if (result.status === "none") return;
    onOpenRef.current(result);
    dropParam(SHARE_PARAM);
  }, [ctx]);

  return useCallback(() => {
    if (handled.current) return false;
    handled.current = true;
    const linked = readShareParam(window.location.search) !== null;
    dropParam(SHARE_PARAM);
    return linked;
  }, []);
}
