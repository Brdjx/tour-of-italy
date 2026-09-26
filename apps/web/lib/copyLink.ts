import type { PrivateAiText } from "@italy/planner";

// Copying a link that is only known after a network call. Copy link saves the trip first (POST
// /api/trips) and copies the short link it gets back; when saving fails, or the trip is not
// saved because it breaks a rule, it copies the ?p= link, which rebuilds the trip from its
// places. Either way the traveler pressed once and gets a link, and the page says which.
//
// Decision: the clipboard write starts inside the press, before the save has answered, with the
// link as a promise (navigator.clipboard.write with a ClipboardItem). Safari drops the user's
// gesture at the first await, so writing after the fetch would be refused there; Chromium and
// Safari accept a promised value. Where that is missing or refused, the link is written with
// writeText once known (browsers that allow it after an await), and failing that the page shows
// it in a field to copy by hand.

/** The parts of navigator.clipboard this uses; either may be missing. */
export interface ClipboardLike {
  write?: (items: ClipboardItem[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

export type MakeClipboardItem = (items: Record<string, Promise<Blob>>) => ClipboardItem;

export interface CopyLinkDeps {
  save: (() => Promise<string>) | null; // the saved trip's link (rejects on failure); null: no save
  fallback: string; // the link to copy when the trip is not saved
  clipboard: ClipboardLike | null;
  makeItem: MakeClipboardItem | null; // null where ClipboardItem does not exist
}

export interface CopyResult {
  link: string;
  saved: boolean; // the link is the saved trip's, not the rebuild-from-places one
  copied: boolean; // it reached the clipboard; false means the page must show it
}

/** The browser's clipboard and ClipboardItem, or null where there are none. */
export function browserClipboard(): Pick<CopyLinkDeps, "clipboard" | "makeItem"> {
  const clipboard = typeof navigator === "undefined" ? null : (navigator.clipboard ?? null);
  const makeItem =
    typeof ClipboardItem === "undefined"
      ? null
      : (items: Record<string, Promise<Blob>>) => new ClipboardItem(items);
  return { clipboard, makeItem };
}

/**
 * Saves and copies. Call it straight from the press handler, with no await before it: the
 * clipboard write must start while the browser still counts the press. Never throws.
 */
export async function copySavedLink(deps: CopyLinkDeps): Promise<CopyResult> {
  const unsaved = { link: deps.fallback, saved: false };
  const chosen = deps.save
    ? deps.save().then(
        (link) => ({ link, saved: true }),
        () => unsaved,
      )
    : Promise.resolve(unsaved);
  const { clipboard, makeItem } = deps;
  if (clipboard?.write && makeItem) {
    try {
      const blob = chosen.then(({ link }) => new Blob([link], { type: "text/plain" }));
      await clipboard.write([makeItem({ "text/plain": blob })]);
      return { ...(await chosen), copied: true };
    } catch {
      // Refused, or a browser without promised values: try writeText below.
    }
  }
  const result = await chosen;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(result.link);
      return { ...result, copied: true };
    } catch {
      // The page shows the link to copy by hand.
    }
  }
  return { ...result, copied: false };
}

/** What the status line and the note under the header say after a copy. */
export const COPY_TEXT = {
  copied: "Link copied.",
  fallbackCopied:
    "Copied a link that rebuilds this trip from its places; the saved link could not be made.",
  manual: "Copy the link from the field below the button.",
  fallbackManual:
    "The saved link could not be made. Copy the link that rebuilds this trip from its places from the field below the button.",
  fallbackNote: "The saved link could not be made; this link rebuilds the trip from its places.",
  // The ?p= link drops the stops that still break a rule when it opens (lib/shareRebuild.ts).
  flagged:
    "This plan has stops that break a rule, so it is not saved. The link rebuilds it from its places and leaves out stops that still break a rule.",
  flaggedOne:
    "This plan has a stop that breaks a rule, so it is not saved. The link rebuilds it from its places and leaves that stop out if it still breaks a rule.",
  // A plan made with notes keeps none of the AI's text in its record (services/api/src/trips).
  private: "To keep your notes private, the shared trip leaves out the AI's summary and why lines.",
} as const;

/**
 * Which days of a saved trip show the rules' why lines where the page shows the AI's: the days
 * the AI planned again (lib/dayCity.ts, replannedAiDays), 1-based. Null when there are none.
 */
// Decision: said, not hidden. A saved trip takes the AI's words only from the AI plan on record
// (services/api/src/trips/rebuild.ts), and a day planned again has none, so the server times that
// day and gives it the rules' why lines. Keeping the page's copy of them would let a client write
// text into a saved trip, which the server never allows.
export function replannedNote(days: readonly number[]): string | null {
  if (days.length === 0) return null;
  if (days.length === 1) {
    return `Day ${days[0]} was planned again, so the saved trip shows the rules' why lines for it.`;
  }
  const which = `${days.slice(0, -1).join(", ")} and ${days.at(-1)}`;
  return `Days ${which} were planned again, so the saved trip shows the rules' why lines for them.`;
}

export function copyStatus(result: CopyResult): string {
  if (result.copied) return result.saved ? COPY_TEXT.copied : COPY_TEXT.fallbackCopied;
  return result.saved ? COPY_TEXT.manual : COPY_TEXT.fallbackManual;
}

/**
 * The sentence saying that a saved trip leaves out the AI's text to keep the traveler's notes
 * private (privateAiText in the planner), or null when the plan had no notes or no AI text.
 */
// Decision: one sentence, not a count. A plan made with notes keeps none of the AI's text, so
// "the AI's summary and why lines" is the whole of it; counts would only add numbers to read.
export function privateNote(left: PrivateAiText): string | null {
  return left.summary || left.reasons > 0 ? COPY_TEXT.private : null;
}

/** Why a plan that breaks a rule was not saved, naming "a stop" or "stops" by count. */
// Decision: only exactly one flagged stop is "a stop". A plan whose only error is about a day
// (no stop flagged) keeps the plural, which reads as general, rather than a third sentence.
export function flaggedNote(stops: number): string {
  return stops === 1 ? COPY_TEXT.flaggedOne : COPY_TEXT.flagged;
}

/** What the page knew about the trip when it was copied. */
export interface CopyContext {
  flagged: boolean; // it breaks a rule, so it was not saved
  flaggedStops?: number; // how many of its stops break a rule, for the wording
  left: PrivateAiText; // what the saved trip leaves out of the AI's text
  replanned?: readonly number[]; // days (1-based) planned again by the AI
}

export interface CopyMessages {
  status: string; // announced, and shown in the status line
  note: string | null; // shown under the trip header
}

/** The status and the note after a copy: which link it is, and why when it is not the saved one. */
// Decision: every sentence that explains a link is shown under the header as well as announced,
// so a sighted traveler reads it too. The button itself only says "Link copied".
export function copyMessages(result: CopyResult, context: CopyContext): CopyMessages {
  if (context.flagged) {
    const note = flaggedNote(context.flaggedStops ?? 0);
    const status = result.copied ? `${COPY_TEXT.copied} ${note}` : `${note} ${COPY_TEXT.manual}`;
    return { status, note };
  }
  if (!result.saved) {
    const note = result.copied ? COPY_TEXT.fallbackCopied : COPY_TEXT.fallbackNote;
    return { status: copyStatus(result), note };
  }
  // A plan made with notes keeps none of the AI's text, days planned again included, so the notes
  // sentence says it all; otherwise the days planned again are named.
  const note = privateNote(context.left) ?? replannedNote(context.replanned ?? []);
  return { status: note ? `${copyStatus(result)} ${note}` : copyStatus(result), note };
}
