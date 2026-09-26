import { alternativesFor, type DayPlan, removeStop, rescheduleDay } from "@italy/planner";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlternativesSheet, EMPTY_ALTERNATIVES } from "../components/AlternativesSheet";
import { ShareButton } from "../components/ShareButton";
import type { SaveTripBody } from "../lib/api";
import { readShareParam } from "../lib/shareLink";
import { ctx, fixturePlan } from "./fixtures";

// The swap sheet is a modal: it must trap focus, close on Escape, hand focus back, and say
// plainly when nothing fits. The share button must work with and without a clipboard.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  empty = false,
  onChoose = vi.fn(),
}: {
  empty?: boolean;
  onChoose?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const plan = fixturePlan();
  const alternatives = empty ? [] : alternativesFor(plan, 0, 1, ctx);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open swap
      </button>
      <div data-live-region="" data-testid="fake-live-region" />
      {open ? (
        <AlternativesSheet
          stopName="Colosseum"
          date={plan.days[0]?.date ?? ""}
          alternatives={alternatives}
          onChoose={onChoose}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("AlternativesSheet", () => {
  it("says what to do when nothing else fits", async () => {
    const user = userEvent.setup();
    render(<Harness empty />);
    await user.click(screen.getByText("Open swap"));
    expect(screen.getByRole("dialog", { name: "Swap Colosseum" })).toBeTruthy();
    expect(screen.getByTestId("alternatives-empty").textContent).toBe(EMPTY_ALTERNATIVES);
    expect(EMPTY_ALTERNATIVES).toBe("Nothing else fits this time slot. Try removing a stop first.");
  });

  it("lists options with their new times and passes the chosen place back", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(<Harness onChoose={onChoose} />);
    await user.click(screen.getByText("Open swap"));
    const options = screen.getAllByTestId("alternative-option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]?.querySelectorAll("time")).toHaveLength(2);
    await user.click(options[0] as HTMLElement);
    const [first] = alternativesFor(fixturePlan(), 0, 1, ctx);
    expect(onChoose).toHaveBeenCalledWith(first?.place.id);
  });

  it("keeps Tab inside the sheet and closes on Escape, returning focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByText("Open swap");
    await user.click(opener);
    const dialog = screen.getByTestId("alternatives-sheet");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const count = dialog.querySelectorAll("button").length;
    for (let index = 0; index < count + 2; index++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("alternatives-sheet")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("makes the page behind it inert, except the live region, and undoes that on close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByText("Open swap");
    await user.click(opener);
    expect(opener.hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("fake-live-region").hasAttribute("inert")).toBe(false);
    await user.keyboard("{Escape}");
    expect(opener.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("still closes on Escape, and Tab returns into it, after a click left focus on the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open swap"));
    const dialog = screen.getByTestId("alternatives-sheet");
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("alternatives-sheet")).toBeNull();
  });

  it("keeps focus in the sheet when its text is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open swap"));
    const dialog = screen.getByTestId("alternatives-sheet");
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    await user.click(screen.getByText("Swap Colosseum"));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("prints option times like the timetable, without a widened colon", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open swap"));
    const times = screen.getAllByTestId("alternative-option")[0]?.querySelectorAll("time") ?? [];
    for (const time of times) {
      expect(time.querySelector(".clock-colon")?.textContent).toBe(":");
      expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("never repeats the type and area an option already shows in its reason", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open swap"));
    for (const option of screen.getAllByTestId("alternative-option")) {
      const [name, subtitle, , reason] = [...option.children].map((child) => child.textContent);
      expect(name).toBeTruthy();
      if (reason && !reason.startsWith("Note:")) expect(reason).not.toContain(`${subtitle}.`);
    }
  });

  it("starts the line of a place that gives the day its missing dinner with the meal", () => {
    // Decision 17: a day with its dinner taken off offers places to eat first for a late visit.
    const plan = fixturePlan();
    const day = plan.days[0];
    const dinner = day?.stops.findIndex((stop) => stop.role === "dinner") ?? -1;
    expect(dinner).toBeGreaterThan(0);
    const edited = rescheduleDay(plan, 0, removeStop(day as DayPlan, dinner), ctx).itinerary;
    const roles = edited.days[0]?.stops.map((stop) => stop.role) ?? [];
    const alternatives = alternativesFor(edited, 0, roles.lastIndexOf("visit"), ctx);
    expect(alternatives[0]?.meal).toBe("dinner");
    render(
      <AlternativesSheet
        stopName="A visit"
        date={edited.days[0]?.date ?? ""}
        alternatives={alternatives}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const [first] = screen.getAllByTestId("alternative-option");
    const subtitle = first?.children[1]?.textContent ?? "";
    expect(subtitle).toMatch(/^Dinner, [a-z]/);
    const meals = screen.queryAllByTestId("alternative-meal").length;
    expect(meals).toBe(alternatives.filter((one) => one.meal !== null).length);
  });

  it("closes from the close button and the backdrop", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByText("Open swap"));
    await user.click(screen.getByTestId("alternatives-close"));
    expect(screen.queryByTestId("alternatives-sheet")).toBeNull();
    await user.click(screen.getByText("Open swap"));
    await user.click(container.ownerDocument.querySelector(".sheet-backdrop") as HTMLElement);
    expect(screen.queryByTestId("alternatives-sheet")).toBeNull();
  });
});

describe("ShareButton", () => {
  const ID = "a1B2c3D4e5";
  const saved = () => Promise.resolve(ID);
  const failed = () => Promise.reject(new Error("offline"));

  it("saves the trip and copies its short link, and says so", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onStatus = vi.fn();
    const saveTrip = vi.fn(async (_body: SaveTripBody) => ID);
    const plan = { ...fixturePlan({ notes: "Private." }), planId: "Zz9Yy8Xx7W" };
    render(<ShareButton itinerary={plan} onStatus={onStatus} saveTrip={saveTrip} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(screen.getByTestId("share-button").textContent).toBe("Link copied");
    const link = new URL(writeText.mock.calls[0]?.[0] as string);
    expect(link.search).toBe(`?t=${ID}`);
    expect(saveTrip).toHaveBeenCalledWith(expect.objectContaining({ planId: "Zz9Yy8Xx7W" }));
    expect(saveTrip.mock.calls[0]?.[0].request.notes).toBeUndefined();
    expect(onStatus).toHaveBeenCalledWith("Link copied.");
    expect(screen.queryByTestId("share-note")).toBeNull();
  });

  it("writes to the clipboard inside the press, with the link still on its way (Safari)", async () => {
    let answer: (id: string) => void = () => {};
    const written: Promise<Blob>[] = [];
    class FakeItem {
      constructor(items: Record<string, Promise<Blob>>) {
        written.push(items["text/plain"] as Promise<Blob>);
      }
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { write: async () => {} } });
    render(
      <ShareButton
        itinerary={fixturePlan()}
        saveTrip={() => new Promise<string>((resolve) => (answer = resolve))}
      />,
    );
    act(() => {
      screen.getByTestId("share-button").click();
    });
    expect(written).toHaveLength(1);
    await act(async () => answer(ID));
    expect(new URL((await (await written[0])?.text()) ?? "").search).toBe(`?t=${ID}`);
    expect(screen.getByTestId("share-button").textContent).toBe("Link copied");
  });

  it("shows a quiet busy state while saving and ignores a second press", async () => {
    let answer: (id: string) => void = () => {};
    const saveTrip = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    render(<ShareButton itinerary={fixturePlan()} saveTrip={saveTrip} />);
    const button = screen.getByTestId("share-button");
    act(() => button.click());
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Copy link");
    act(() => button.click());
    expect(saveTrip).toHaveBeenCalledTimes(1);
    await act(async () => answer(ID));
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("names the saved trip a plan was opened from, so saving it again keeps its why lines", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    const saveTrip = vi.fn(saved);
    render(<ShareButton itinerary={fixturePlan()} saveTrip={saveTrip} savedFrom="Zz9Yy8Xx7W" />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(saveTrip).toHaveBeenCalledWith(expect.objectContaining({ tripId: "Zz9Yy8Xx7W" }));
  });

  it("copies the link that rebuilds the plan from its places when saving fails, and says so", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onStatus = vi.fn();
    render(<ShareButton itinerary={fixturePlan()} onStatus={onStatus} saveTrip={failed} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    const link = new URL(writeText.mock.calls[0]?.[0] as string);
    expect(readShareParam(link.search)).toBeTruthy();
    expect(screen.getByTestId("share-button").textContent).toBe("Link copied");
    const note =
      "Copied a link that rebuilds this trip from its places; the saved link could not be made.";
    expect(screen.getByTestId("share-note").textContent).toBe(note);
    expect(onStatus).toHaveBeenCalledWith(note);
  });

  it("says nothing about a copy that finished after the plan changed", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    const onStatus = vi.fn();
    let answer: (id: string) => void = () => {};
    const saveTrip = () => new Promise<string>((resolve) => (answer = resolve));
    const { rerender } = render(
      <ShareButton itinerary={fixturePlan()} onStatus={onStatus} saveTrip={saveTrip} />,
    );
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(screen.getByTestId("share-button").getAttribute("aria-busy")).toBe("true");

    rerender(
      <ShareButton
        itinerary={fixturePlan({ pace: "relaxed" })}
        onStatus={onStatus}
        saveTrip={saveTrip}
      />,
    );
    await act(async () => answer(ID));

    // The field and the line would be about the plan before, so neither appears.
    expect(screen.queryByTestId("share-link-field")).toBeNull();
    expect(screen.queryByTestId("share-note")).toBeNull();
    expect(onStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-button").getAttribute("aria-busy")).toBeNull();
  });

  it("does not save a plan with flagged stops, and says the link rebuilds it without them", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onStatus = vi.fn();
    const saveTrip = vi.fn(saved);
    render(
      <ShareButton itinerary={fixturePlan()} onStatus={onStatus} saveTrip={saveTrip} flagged />,
    );
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(saveTrip).not.toHaveBeenCalled();
    expect(readShareParam(new URL(writeText.mock.calls[0]?.[0] as string).search)).toBeTruthy();
    const note =
      "This plan has stops that break a rule, so it is not saved. The link rebuilds it from its places and leaves out stops that still break a rule.";
    expect(screen.getByTestId("share-note").textContent).toBe(note);
    expect(onStatus).toHaveBeenCalledWith(`Link copied. ${note}`);
  });

  it("says what the shared trip leaves out when the plan was made with notes", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    const onStatus = vi.fn();
    const plan = { ...fixturePlan({ notes: "Knee surgery." }), planId: "Zz9Yy8Xx7W" };
    render(
      <ShareButton
        itinerary={plan}
        onStatus={onStatus}
        saveTrip={saved}
        privateText={{ summary: true, reasons: 2 }}
      />,
    );
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    const note =
      "To keep your notes private, the shared trip leaves out the AI's summary and why lines.";
    expect(screen.getByTestId("share-note").textContent).toBe(note);
    expect(onStatus).toHaveBeenCalledWith(`Link copied. ${note}`);
  });

  it("claims nothing about the notes for a plan with no AI content on record", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    const onStatus = vi.fn();
    const plan = fixturePlan({ notes: "Knee surgery." }); // no planId: saved with rule why lines
    render(
      <ShareButton
        itinerary={plan}
        onStatus={onStatus}
        saveTrip={saved}
        privateText={{ summary: true, reasons: 2 }}
      />,
    );
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(onStatus).toHaveBeenCalledWith("Link copied.");
    expect(screen.queryByTestId("share-note")).toBeNull();
  });

  it("shows the link to copy by hand when the clipboard is refused", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    const { unmount } = render(<ShareButton itinerary={fixturePlan()} saveTrip={saved} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect((screen.getByTestId("share-link-field") as HTMLInputElement).value).toContain(
      `?t=${ID}`,
    );
    expect(screen.getByTestId("share-button").textContent).toBe("Copy link");
    unmount();

    render(<ShareButton itinerary={fixturePlan()} saveTrip={failed} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect((screen.getByTestId("share-link-field") as HTMLInputElement).value).toContain("?p=");
    expect(screen.getByTestId("share-note").textContent).toContain("could not be made");
  });

  it("saves through POST /api/trips when no stand-in is given", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const fetchStub = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: ID }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    render(<ShareButton itinerary={fixturePlan()} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(String(fetchStub.mock.calls[0]?.[0])).toMatch(/\/api\/trips$/);
    expect(fetchStub.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(new URL(writeText.mock.calls[0]?.[0] as string).search).toBe(`?t=${ID}`);
  });

  it("goes back to Copy link after a moment", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    render(<ShareButton itinerary={fixturePlan()} saveTrip={saved} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(screen.getByTestId("share-button").textContent).toBe("Link copied");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("share-button").textContent).toBe("Copy link");
    vi.useRealTimers();
  });
});
