import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorState, Notice } from "../components/ErrorState";
import { SourceBadge } from "../components/SourceBadge";
import { LiveRegion, Toast } from "../components/StatusRegion";
import { WarningChips } from "../components/WarningChip";
import type { Chip } from "../lib/chips";
import { aiPlan, fixturePlan } from "./fixtures";

// Badges, chips, and banners carry the plan's caveats. None of them may depend on hover, and
// each must say its piece in plain words.

afterEach(cleanup);

describe("SourceBadge", () => {
  it.each([
    ["ai", "Planned with AI, checked against hours and distance"],
    ["ai_repaired", "Planned with AI, fixed after a check"],
    ["deterministic", "Planned without AI"],
  ] as const)("says who planned a %s plan", (source, label) => {
    render(<SourceBadge itinerary={{ ...aiPlan(), source }} origin="api" />);
    expect(screen.getByTestId("source-badge").textContent).toContain(label);
    expect(screen.queryByTestId("offline-label")).toBeNull();
  });

  it("marks a plan built in the browser with the offline label", () => {
    render(<SourceBadge itinerary={fixturePlan()} origin="offline" cause="offline" />);
    expect(screen.getByTestId("offline-label").textContent).toBe("Planned without AI, offline");
    expect(screen.getByTestId("source-badge").dataset.marker).toBe("rules");
  });

  it("never says offline when the planner service answered with an error", () => {
    render(<SourceBadge itinerary={fixturePlan()} origin="offline" cause="server" />);
    expect(screen.queryByTestId("offline-label")).toBeNull();
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Planned without AI, on this device",
    );
  });

  it("uses the filled AI dot only for AI plans, the open dot otherwise", () => {
    const { rerender } = render(<SourceBadge itinerary={aiPlan()} origin="api" />);
    expect(screen.getByTestId("source-badge").dataset.marker).toBe("ai");
    rerender(<SourceBadge itinerary={fixturePlan()} origin="api" />);
    expect(screen.getByTestId("source-badge").dataset.marker).toBe("rules");
    rerender(<SourceBadge itinerary={aiPlan()} origin="shared" />);
    expect(screen.getByTestId("source-badge").dataset.marker).toBe("rules");
  });

  it("stops claiming the plan was checked once an edit breaks a rule", () => {
    render(<SourceBadge itinerary={aiPlan()} origin="api" errors={2} edited />);
    const badge = screen.getByTestId("source-badge");
    expect(badge.textContent).toContain("Edited by you, 2 problems to fix");
    expect(badge.textContent).not.toContain("checked against hours");
    expect(badge.dataset.marker).toBe("problem");
  });

  it("opens the pipeline details on click and closes on Escape, with the fallback reason", async () => {
    const user = userEvent.setup();
    const plan = fixturePlan();
    const timedOut = { ...plan, meta: { ...plan.meta, fallbackReason: "timeout" as const } };
    render(<SourceBadge itinerary={timedOut} origin="api" />);
    const button = screen.getByRole("button", { expanded: false });
    const details = screen.getByTestId("source-details");
    expect(details.hidden).toBe(true);
    await user.click(button);
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain("didn't return a valid plan in time");
    await user.keyboard("{Escape}");
    expect(details.hidden).toBe(true);
  });
});

const chips: Chip[] = [
  { key: "a", label: "Hours not confirmed", explanation: "No hours listed.", tone: "warning" },
  { key: "b", label: "Book ahead", explanation: "Book before you go.", tone: "note" },
  { key: "c", label: "Closed at this time", explanation: "Closed then.", tone: "error" },
];

describe("WarningChips", () => {
  it("shows each chip's text and hides every explanation until asked", () => {
    render(<WarningChips chips={chips} />);
    expect(screen.getAllByTestId("warning-chip").map((chip) => chip.textContent)).toEqual([
      "Hours not confirmed",
      "Book ahead",
      "Problem: Closed at this time",
    ]);
    for (const explanation of screen.getAllByTestId("chip-explanation")) {
      expect(explanation.hidden).toBe(true);
    }
  });

  it("explains on keyboard focus and hides again on blur", async () => {
    const user = userEvent.setup();
    render(<WarningChips chips={chips} />);
    await user.tab();
    expect(screen.getByText("No hours listed.").hidden).toBe(false);
    await user.tab();
    expect(screen.getByText("No hours listed.").hidden).toBe(true);
    expect(screen.getByText("Book before you go.").hidden).toBe(false);
    await user.keyboard("{Escape}");
    expect(screen.getByText("Book before you go.").hidden).toBe(true);
  });

  it("explains on tap and closes on a second tap, without opening on hover", async () => {
    const user = userEvent.setup();
    render(<WarningChips chips={chips} />);
    const chip = screen.getAllByTestId("warning-chip")[1] as HTMLElement;
    await user.hover(chip);
    expect(screen.getByText("Book before you go.").hidden).toBe(true);
    await user.click(chip);
    expect(screen.getByText("Book before you go.").hidden).toBe(false);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await user.click(chip);
    expect(screen.getByText("Book before you go.").hidden).toBe(true);
  });

  it("keeps an open explanation until a press elsewhere has clicked, so the press is not lost", async () => {
    // Chromium focuses on mousedown; closing then would move the button under the pointer and
    // the click would land on nothing. The explanation must still be there when the click fires.
    const user = userEvent.setup();
    const seen: boolean[] = [];
    render(
      <>
        <WarningChips chips={chips} />
        <button
          type="button"
          onClick={() => seen.push(!screen.getByText("No hours listed.").hidden)}
        >
          Swap
        </button>
      </>,
    );
    await user.click(screen.getAllByTestId("warning-chip")[0] as HTMLElement);
    expect(screen.getByText("No hours listed.").hidden).toBe(false);
    await user.click(screen.getByText("Swap"));
    expect(seen).toEqual([true]);
    await waitFor(() => expect(screen.getByText("No hours listed.").hidden).toBe(true));
  });

  it("describes each chip with its explanation for screen readers even when closed", () => {
    render(<WarningChips chips={chips} />);
    const chip = screen.getAllByTestId("warning-chip")[0] as HTMLElement;
    const describedBy = chip.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)?.textContent).toBe("No hours listed.");
  });

  it("renders nothing when there are no chips", () => {
    const { container } = render(<WarningChips chips={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("banners and status", () => {
  it("shows an error as an alert with a retry", async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState message="The planner is unavailable. Try again in a moment." onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The planner is unavailable");
    fireEvent.click(screen.getByTestId("retry-button"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("lets the traveler dismiss a note", () => {
    const onDismiss = vi.fn();
    render(<Notice message="Opened a shared plan." onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss note" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("announces status politely and shows a toast with undo that goes away on its own", () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    render(
      <>
        <LiveRegion message="Removed Colosseum. Times updated." serial={1} />
        <Toast
          message="Removed Colosseum. Times updated."
          serial={1}
          undoLabel="Undo remove"
          onUndo={onUndo}
        />
      </>,
    );
    expect(screen.getByRole("status").textContent).toBe("Removed Colosseum. Times updated.");
    fireEvent.click(screen.getByTestId("toast-undo"));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("toast")).toBeNull();
    vi.useRealTimers();
  });
});
