"use client";

import type { Itinerary } from "@italy/planner";
import { useEffect, useRef, useState } from "react";
import { shareUrl } from "../lib/shareLink";
import { CheckIcon, LinkIcon } from "./icons";

// Copies a link that reopens this plan. When the clipboard is not available (an insecure
// context, a denied permission), the link is shown in a read-only field to copy by hand.

/** How long the button says "Link copied". */
export const COPIED_MS = 2500;

interface ShareButtonProps {
  itinerary: Itinerary;
  onStatus?: (message: string) => void;
}

export function ShareButton({ itinerary, onStatus }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (manual) fieldRef.current?.select();
  }, [manual]);

  const copy = async () => {
    const link = shareUrl(itinerary, `${window.location.origin}${window.location.pathname}`);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard not available");
      await navigator.clipboard.writeText(link);
      setManual(null);
      setCopied(true);
      onStatus?.("Link copied.");
    } catch {
      setManual(link);
      onStatus?.("Copy the link from the field below the button.");
    }
  };

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={copy}
        className="toolbar-button"
        data-testid="share-button"
        data-copied={copied ? "true" : undefined}
      >
        {copied ? <CheckIcon size={18} /> : <LinkIcon size={18} />}
        {copied ? "Link copied" : "Copy link"}
      </button>
      {manual ? (
        <label className="mt-2 block text-sm text-fg">
          Copy this link
          <input
            ref={fieldRef}
            readOnly
            value={manual}
            className="mt-1 block min-h-11 w-full min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg"
            data-testid="share-link-field"
          />
        </label>
      ) : null}
    </div>
  );
}
