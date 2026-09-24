"use client";

import type { PlannerContext } from "@italy/planner";
import { useEffect, useRef } from "react";
import { decodeShare, readShareParam, SHARE_PARAM, type ShareDecode } from "./shareLink";

type OpenedLink = Exclude<ShareDecode, { status: "none" }>;

/**
 * Reads ?p= once, as soon as the places are loaded, hands the decoded result to `onOpen`, then
 * removes ?p= from the address bar so a reload does not reopen a plan the traveler has since
 * changed. Does nothing when there is no link.
 */
export function useSharedLinkOnLoad(
  ctx: PlannerContext | null,
  onOpen: (result: OpenedLink) => void,
): void {
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
    const url = new URL(window.location.href);
    url.searchParams.delete(SHARE_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [ctx]);
}
