"use client";

import type { Itinerary } from "@italy/planner";
import { type RefObject, useEffect, useRef, useState } from "react";
import { shareUrl } from "../lib/shareLink";
import { CheckIcon, LinkIcon } from "./icons";

// Copies a link that reopens this plan. When the clipboard is not available (an insecure
// context, a denied permission), the link is shown in a read-only field to copy by hand. The
// button and the field are separate pieces, so the trip header can put the button beside Edit
// trip and the field under the whole header.

/** How long the button says "Link copied". */
export const COPIED_MS = 2500;

export interface ShareLink {
  copied: boolean;
  manual: string | null; // the link to copy by hand, after the clipboard refused
  copy: () => Promise<void>;
  fieldRef: RefObject<HTMLInputElement | null>;
}

export function useShareLink(
  itinerary: Itinerary | null,
  onStatus?: (message: string) => void,
): ShareLink {
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
    if (!itinerary) return;
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

  return { copied, manual, copy, fieldRef };
}

interface ShareLinkButtonProps {
  share: ShareLink;
  className?: string;
  labelClassName?: string; // the trip header hides the words on phones, keeping them as the name
}

export function ShareLinkButton({ share, className, labelClassName }: ShareLinkButtonProps) {
  return (
    <button
      type="button"
      onClick={share.copy}
      className={className ?? "toolbar-button"}
      data-testid="share-button"
      data-copied={share.copied ? "true" : undefined}
    >
      {share.copied ? <CheckIcon size={18} /> : <LinkIcon size={18} />}
      <span className={labelClassName}>{share.copied ? "Link copied" : "Copy link"}</span>
    </button>
  );
}

export function ShareLinkField({ share }: { share: ShareLink }) {
  if (!share.manual) return null;
  return (
    <label className="mt-2 block text-sm text-fg">
      Copy this link
      <input
        ref={share.fieldRef}
        readOnly
        value={share.manual}
        className="mt-1 block min-h-11 w-full min-w-0 rounded-none border border-line-strong bg-surface px-3 text-base text-fg"
        data-testid="share-link-field"
      />
    </label>
  );
}

interface ShareButtonProps {
  itinerary: Itinerary;
  onStatus?: (message: string) => void;
}

/** The button with its fallback field under it, for a place that has room for both. */
export function ShareButton({ itinerary, onStatus }: ShareButtonProps) {
  const share = useShareLink(itinerary, onStatus);
  return (
    <div className="min-w-0">
      <ShareLinkButton share={share} />
      <ShareLinkField share={share} />
    </div>
  );
}
