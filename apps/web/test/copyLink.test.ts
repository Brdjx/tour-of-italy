import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserClipboard,
  type ClipboardLike,
  COPY_TEXT,
  copyMessages,
  copySavedLink,
  copyStatus,
  flaggedNote,
  type MakeClipboardItem,
  privateNote,
} from "../lib/copyLink";

// Copy link saves the trip, then copies the link the save returns, from one press. Safari forgets
// the press at the first await, so the clipboard write has to start before the save answers,
// with the link as a promise; other browsers fall back to writing it once known, and the page
// shows it to copy by hand when the clipboard refuses.

const SAVED = "https://italy-planner.brdjx.com/?t=a1B2c3D4e5";
const FALLBACK = "https://italy-planner.brdjx.com/?p=eyJ2IjoxfQ";

/** A ClipboardItem stand-in that keeps what it was given. */
const makeItem: MakeClipboardItem = (items) => ({ items }) as unknown as ClipboardItem;

async function textOf(item: ClipboardItem): Promise<string> {
  const blob = await (item as unknown as { items: Record<string, Promise<Blob>> }).items[
    "text/plain"
  ];
  return (blob as Blob).text();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copySavedLink", () => {
  it("starts the clipboard write before the save answers, with the saved link as a promise", async () => {
    let answer: (link: string) => void = () => {};
    const save = () => new Promise<string>((resolve) => (answer = resolve));
    const written: ClipboardItem[] = [];
    const clipboard: ClipboardLike = {
      write: async (items) => {
        written.push(...items);
        await textOf(items[0] as ClipboardItem);
      },
    };

    const copying = copySavedLink({ save, fallback: FALLBACK, clipboard, makeItem });

    // Written during the press, before any answer: the link itself is still on its way.
    expect(written).toHaveLength(1);
    answer(SAVED);
    expect(await copying).toEqual({ link: SAVED, saved: true, copied: true });
    expect(await textOf(written[0] as ClipboardItem)).toBe(SAVED);
  });

  it("copies the link that rebuilds the trip from its places when saving fails", async () => {
    const written: ClipboardItem[] = [];
    const clipboard: ClipboardLike = {
      write: async (items) => {
        written.push(...items);
      },
    };

    const result = await copySavedLink({
      save: () => Promise.reject(new Error("offline")),
      fallback: FALLBACK,
      clipboard,
      makeItem,
    });

    expect(result).toEqual({ link: FALLBACK, saved: false, copied: true });
    expect(await textOf(written[0] as ClipboardItem)).toBe(FALLBACK);
  });

  it("writes the text once known when the promised write is refused or missing", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const refused: ClipboardLike = {
      write: () => Promise.reject(new Error("NotAllowedError")),
      writeText,
    };

    const afterRefusal = await copySavedLink({
      save: async () => SAVED,
      fallback: FALLBACK,
      clipboard: refused,
      makeItem,
    });
    const withoutItem = await copySavedLink({
      save: async () => SAVED,
      fallback: FALLBACK,
      clipboard: { write: refused.write, writeText },
      makeItem: null,
    });

    expect(afterRefusal).toEqual({ link: SAVED, saved: true, copied: true });
    expect(withoutItem.copied).toBe(true);
    expect(writeText.mock.calls).toEqual([[SAVED], [SAVED]]);
  });

  it("hands the link back to show by hand when every clipboard route fails", async () => {
    const denied: ClipboardLike = { writeText: () => Promise.reject(new Error("denied")) };

    const refused = await copySavedLink({
      save: async () => SAVED,
      fallback: FALLBACK,
      clipboard: denied,
      makeItem,
    });
    const none = await copySavedLink({
      save: () => Promise.reject(new Error("503")),
      fallback: FALLBACK,
      clipboard: null,
      makeItem: null,
    });

    expect(refused).toEqual({ link: SAVED, saved: true, copied: false });
    expect(none).toEqual({ link: FALLBACK, saved: false, copied: false });
  });
});

describe("copySavedLink without a save", () => {
  it("copies the rebuild link at once and never saves", async () => {
    const writeText = vi.fn(async (_text: string) => {});

    const result = await copySavedLink({
      save: null,
      fallback: FALLBACK,
      clipboard: { writeText },
      makeItem: null,
    });

    expect(result).toEqual({ link: FALLBACK, saved: false, copied: true });
    expect(writeText).toHaveBeenCalledWith(FALLBACK);
  });
});

describe("privateNote", () => {
  it("says the shared trip leaves out the AI's text whenever there is some, or nothing", () => {
    const sentence =
      "To keep your notes private, the shared trip leaves out the AI's summary and why lines.";
    expect(privateNote({ summary: false, reasons: 0 })).toBeNull();
    expect(privateNote({ summary: true, reasons: 0 })).toBe(sentence);
    expect(privateNote({ summary: false, reasons: 1 })).toBe(sentence);
    expect(privateNote({ summary: true, reasons: 3 })).toBe(sentence);
  });
});

describe("flaggedNote", () => {
  it("says a stop or stops by how many are flagged", () => {
    expect(flaggedNote(1)).toBe(
      "This plan has a stop that breaks a rule, so it is not saved. The link rebuilds it from its places and leaves that stop out if it still breaks a rule.",
    );
    expect(flaggedNote(2)).toBe(
      "This plan has stops that break a rule, so it is not saved. The link rebuilds it from its places and leaves out stops that still break a rule.",
    );
    // Only a day breaks a rule: the plural, which reads as general.
    expect(flaggedNote(0)).toBe(COPY_TEXT.flagged);
  });
});

describe("copyMessages", () => {
  const none = { summary: false, reasons: 0 };
  const some = { summary: true, reasons: 0 };

  it("says a flagged plan was not saved, whether or not the clipboard took the link", () => {
    const copied = copyMessages(
      { link: FALLBACK, saved: false, copied: true },
      { flagged: true, left: some },
    );
    expect(copied).toEqual({
      status: `Link copied. ${COPY_TEXT.flagged}`,
      note: COPY_TEXT.flagged,
    });
    const manual = copyMessages(
      { link: FALLBACK, saved: false, copied: false },
      { flagged: true, left: none },
    );
    expect(manual).toEqual({
      status: `${COPY_TEXT.flagged} ${COPY_TEXT.manual}`,
      note: COPY_TEXT.flagged,
    });
  });

  it("names one flagged stop as a stop", () => {
    const copied = copyMessages(
      { link: FALLBACK, saved: false, copied: true },
      { flagged: true, flaggedStops: 1, left: none },
    );
    expect(copied).toEqual({
      status: `Link copied. ${COPY_TEXT.flaggedOne}`,
      note: COPY_TEXT.flaggedOne,
    });
  });

  it("says the saved link could not be made, and nothing about notes the link cannot carry", () => {
    const copied = copyMessages(
      { link: FALLBACK, saved: false, copied: true },
      { flagged: false, left: some },
    );
    expect(copied).toEqual({ status: COPY_TEXT.fallbackCopied, note: COPY_TEXT.fallbackCopied });
    const manual = copyMessages(
      { link: FALLBACK, saved: false, copied: false },
      { flagged: false, left: none },
    );
    expect(manual).toEqual({ status: COPY_TEXT.fallbackManual, note: COPY_TEXT.fallbackNote });
  });

  it("adds what a saved trip leaves out to the status and the note", () => {
    const note = privateNote(some) as string;
    const copied = copyMessages(
      { link: SAVED, saved: true, copied: true },
      { flagged: false, left: some },
    );
    expect(copied).toEqual({ status: `Link copied. ${note}`, note });
    expect(copied.status).toBe(
      "Link copied. To keep your notes private, the shared trip leaves out the AI's summary and why lines.",
    );
    const manual = copyMessages(
      { link: SAVED, saved: true, copied: false },
      { flagged: false, left: some },
    );
    expect(manual).toEqual({ status: `${COPY_TEXT.manual} ${note}`, note });
    const plain = copyMessages(
      { link: SAVED, saved: true, copied: true },
      { flagged: false, left: none },
    );
    expect(plain).toEqual({ status: "Link copied.", note: null });
  });
});

describe("copyStatus", () => {
  it("says plainly which link was copied, or where to copy it from", () => {
    expect(copyStatus({ link: SAVED, saved: true, copied: true })).toBe("Link copied.");
    expect(copyStatus({ link: FALLBACK, saved: false, copied: true })).toBe(
      COPY_TEXT.fallbackCopied,
    );
    expect(copyStatus({ link: SAVED, saved: true, copied: false })).toBe(COPY_TEXT.manual);
    expect(copyStatus({ link: FALLBACK, saved: false, copied: false })).toBe(
      COPY_TEXT.fallbackManual,
    );
  });
});

describe("browserClipboard", () => {
  it("offers ClipboardItem where the browser has it, and nothing where it does not", () => {
    class FakeItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    const { makeItem: make } = browserClipboard();
    const item = make?.({ "text/plain": Promise.resolve(new Blob(["x"])) });
    expect(item).toBeInstanceOf(FakeItem);

    vi.stubGlobal("ClipboardItem", undefined);
    expect(browserClipboard().makeItem).toBeNull();
  });

  it("reads navigator.clipboard, and copes with a browser that has none", () => {
    const clipboard = { writeText: async () => {} };
    vi.stubGlobal("navigator", { clipboard });
    expect(browserClipboard().clipboard).toBe(clipboard);
    vi.stubGlobal("navigator", {});
    expect(browserClipboard().clipboard).toBeNull();
    vi.stubGlobal("navigator", undefined);
    expect(browserClipboard().clipboard).toBeNull();
  });
});
