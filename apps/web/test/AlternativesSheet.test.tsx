import { alternativesFor } from "@italy/planner";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlternativesSheet, EMPTY_ALTERNATIVES } from "../components/AlternativesSheet";
import { ShareButton } from "../components/ShareButton";
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
  it("copies a link that decodes to this plan and says so", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onStatus = vi.fn();
    const plan = fixturePlan();
    render(<ShareButton itinerary={plan} onStatus={onStatus} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    expect(screen.getByTestId("share-button").textContent).toBe("Link copied");
    const link = new URL(writeText.mock.calls[0]?.[0] as string);
    expect(readShareParam(link.search)).toBeTruthy();
    expect(onStatus).toHaveBeenCalledWith("Link copied.");
  });

  it("shows the link to copy by hand when the clipboard is refused", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    render(<ShareButton itinerary={fixturePlan()} />);
    await act(async () => {
      screen.getByTestId("share-button").click();
    });
    const field = screen.getByTestId("share-link-field") as HTMLInputElement;
    expect(field.value).toContain("?p=");
    expect(screen.getByTestId("share-button").textContent).toBe("Copy link");
  });

  it("goes back to Copy link after a moment", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    render(<ShareButton itinerary={fixturePlan()} />);
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
