"use client";

import type { Itinerary, PrivateAiText } from "@italy/planner";
import { type RefObject, useEffect, useRef, useState } from "react";
import { postTrip, type SaveTripBody } from "../lib/api";
import { browserClipboard, copyMessages, copySavedLink } from "../lib/copyLink";
import { saveTripBody, TRIP_PARAM } from "../lib/savedTrip";
import { shareUrl } from "../lib/shareLink";
import { CheckIcon, LinkIcon } from "./icons";

// Copies a link that reopens this plan. The trip is saved on the server first and the short
// saved-trip link is copied (lib/copyLink.ts); when saving fails, or the plan has stops that
// break a rule (the server would refuse it), the link that rebuilds the trip from its places is
// copied instead, and a line under the header says why. A saved trip of a plan made with notes
// leaves some AI text out, and the same line says what. When the clipboard is not available (an
// insecure context, a denied permission), the link is shown in a read-only field to copy by
// hand. The button and the field are separate pieces, so the trip header can put the button
// beside Edit trip and the field under the whole header.

/** How long the button says "Link copied". */
export const COPIED_MS = 2500;

/** Saves a trip and resolves to its id: POST /api/trips, or a stand-in in tests. */
export type SaveTrip = (body: SaveTripBody) => Promise<string>;

export interface ShareLink {
  copied: boolean;
  busy: boolean; // saving the trip, before anything is copied
  manual: string | null; // the link to copy by hand, after the clipboard refused
  note: string | null; // why the link is not the saved one, or what the saved one leaves out
  copy: () => void;
  fieldRef: RefObject<HTMLInputElement | null>;
}

export interface ShareLinkOptions {
  savedFrom?: string | null; // the saved trip on screen came from this id
  saveTrip?: SaveTrip;
  flagged?: boolean; // the plan breaks a rule right now, so it is not saved
  flaggedStops?: number; // how many of its stops break a rule, for the note's wording
  privateText?: PrivateAiText; // what a saved trip of it leaves out (privateAiText)
  replannedAi?: readonly number[]; // days (1-based) planned again by the AI (replannedAiDays)
}

const NOTHING_LEFT_OUT: PrivateAiText = { summary: false, reasons: 0 };

export function useShareLink(
  itinerary: Itinerary | null,
  onStatus?: (message: string) => void,
  options: ShareLinkOptions = {},
): ShareLink {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const planGen = useRef(0); // counts the plans this button has served

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (manual) fieldRef.current?.select();
  }, [manual]);

  // A new plan, an edit, or no plan while the next one is on its way: a link shown for copying
  // by hand, "Link copied", or the line under the header belongs to the plan before. All go, and
  // a copy still saving for it will not bring them back (planGen).
  // biome-ignore lint/correctness/useExhaustiveDependencies: itinerary is the trigger, not read.
  useEffect(() => {
    planGen.current += 1;
    setManual(null);
    setCopied(false);
    setNote(null);
  }, [itinerary]);

  // Decision: no await before copySavedLink. The clipboard write inside it must start while the
  // browser still counts this press (Safari forgets it at the first await).
  // Decision: a plan with flagged stops is not sent to be saved at all. The server refuses a
  // trip that breaks a rule, so the page skips the round trip and says why at once.
  const copy = () => {
    if (!itinerary || busyRef.current) return;
    const base = `${window.location.origin}${window.location.pathname}`;
    const save = options.saveTrip ?? ((body: SaveTripBody) => postTrip(body));
    const body = saveTripBody(itinerary, options.savedFrom ?? null);
    const flagged = options.flagged ?? false;
    // Only AI content from the plan's record is left out; without a planId there is none to keep.
    const left =
      body.planId === undefined ? NOTHING_LEFT_OUT : (options.privateText ?? NOTHING_LEFT_OUT);
    const gen = planGen.current;
    busyRef.current = true;
    setBusy(true);
    setNote(null);
    void copySavedLink({
      save: flagged ? null : () => save(body).then((id) => `${base}?${TRIP_PARAM}=${id}`),
      fallback: shareUrl(itinerary, base),
      ...browserClipboard(),
    }).then((result) => {
      busyRef.current = false;
      setBusy(false);
      if (gen !== planGen.current) return; // the plan changed while it saved
      setManual(result.copied ? null : result.link);
      setCopied(result.copied);
      const flaggedStops = options.flaggedStops ?? 0;
      const replanned = options.replannedAi ?? [];
      const messages = copyMessages(result, { flagged, flaggedStops, left, replanned });
      setNote(messages.note);
      onStatus?.(messages.status);
    });
  };

  return { copied, busy, manual, note, copy, fieldRef };
}

interface ShareLinkButtonProps {
  share: ShareLink;
  className?: string;
  disabled?: boolean; // no plan on screen yet: dimmed, focusable, and a press does nothing
}

export function ShareLinkButton({ share, className, disabled = false }: ShareLinkButtonProps) {
  const copied = share.copied && !disabled;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : share.copy}
      className={className ?? "toolbar-button"}
      aria-disabled={disabled || undefined}
      data-testid="share-button"
      data-copied={copied ? "true" : undefined}
      aria-busy={share.busy ? true : undefined}
    >
      {copied ? <CheckIcon size={18} /> : <LinkIcon size={18} />}
      <span>{copied ? "Link copied" : "Copy link"}</span>
    </button>
  );
}

/** The link to copy by hand, and the line saying which link it is and why. */
export function ShareLinkField({ share }: { share: ShareLink }) {
  if (!share.manual && !share.note) return null;
  return (
    <>
      {share.note ? (
        <p className="mt-2 text-sm text-muted" data-testid="share-note">
          {share.note}
        </p>
      ) : null}
      {share.manual ? (
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
      ) : null}
    </>
  );
}

interface ShareButtonProps extends ShareLinkOptions {
  itinerary: Itinerary;
  onStatus?: (message: string) => void;
}

/** The button with its fallback field under it, for a place that has room for both. */
export function ShareButton({ itinerary, onStatus, ...options }: ShareButtonProps) {
  const share = useShareLink(itinerary, onStatus, options);
  return (
    <div className="min-w-0">
      <ShareLinkButton share={share} />
      <ShareLinkField share={share} />
    </div>
  );
}
