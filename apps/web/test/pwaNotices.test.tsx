import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_NO_PLACES, OfflineBanner } from "../components/OfflineBanner";
import { UpdatePrompt } from "../components/UpdatePrompt";
import type { PendingUpdate, startServiceWorker } from "../lib/sw/register";

// The two app-level notices. What would break the product: a new version applied without the
// traveler's tap (files swapped under a running page), a prompt that cannot be acted on, a
// listener left behind after unmount, or an offline state the page never admits to.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakeStart() {
  let offer: ((update: PendingUpdate) => void) | null = null;
  const stop = vi.fn();
  const start = vi.fn((onUpdate: (update: PendingUpdate) => void) => {
    offer = onUpdate;
    return stop;
  }) as unknown as typeof startServiceWorker;
  return { start, stop, offer: (update: PendingUpdate) => act(() => offer?.(update)) };
}

describe("UpdatePrompt", () => {
  it("shows nothing until a new version is waiting", () => {
    const { start } = fakeStart();
    render(<UpdatePrompt start={start} />);
    expect(screen.queryByTestId("update-prompt")).toBeNull();
    expect(screen.getByTestId("update-status").textContent).toBe("");
  });

  it("offers the new version and applies it only when the traveler taps Reload", async () => {
    const user = userEvent.setup();
    const { start, offer } = fakeStart();
    const apply = vi.fn();
    render(<UpdatePrompt start={start} />);
    offer({ apply });
    expect(screen.getByTestId("update-prompt").textContent).toContain(
      "A new version is available.",
    );
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("announces the prompt through a status region that is always in the page", () => {
    const { start, offer } = fakeStart();
    render(<UpdatePrompt start={start} />);
    const region = screen.getByRole("status");
    offer({ apply: () => {} });
    expect(region.textContent).toContain("A new version is available.");
  });

  it("registers once and stops listening when it unmounts", () => {
    const { start, stop } = fakeStart();
    const { rerender, unmount } = render(<UpdatePrompt start={start} />);
    rerender(<UpdatePrompt start={start} />);
    expect(start).toHaveBeenCalledTimes(1);
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("OfflineBanner", () => {
  function setOnline(online: boolean) {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(online);
    act(() => {
      window.dispatchEvent(new Event(online ? "online" : "offline"));
    });
  }

  it("stays out of the way while online", () => {
    render(<OfflineBanner canPlan />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("says the device is offline and that plans are made on it without AI, then clears", () => {
    render(<OfflineBanner canPlan />);
    setOnline(false);
    expect(screen.getByTestId("offline-banner").textContent).toBe(
      "You are offline. New plans are made on this device, without AI.",
    );
    setOnline(true);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("shows the banner at once when the page opens offline", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<OfflineBanner canPlan />);
    expect(screen.getByTestId("offline-banner")).toBeTruthy();
  });

  it("never promises an offline plan when the places are not on this device", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<OfflineBanner canPlan={false} />);
    const text = screen.getByTestId("offline-banner").textContent ?? "";
    expect(text).toBe(OFFLINE_NO_PLACES);
    expect(text).not.toContain("New plans are made");
  });
});
