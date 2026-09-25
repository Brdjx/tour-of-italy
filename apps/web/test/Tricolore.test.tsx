import type { Itinerary, TripRequest } from "@italy/planner";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagMark } from "../components/FlagMark";
import { PlannerApp } from "../components/PlannerApp";
import { SHADE_OFFSETS, WAVE_FRAMES } from "../lib/flagWave";
import { aiPlan, must, tripData } from "./fixtures";

// The Tricolore Rule's two places: the band at the top of the page, on the first screen and the
// plan alike, and the flag mark that leads the first screen's title. Both are decoration, hidden
// from assistive technology. The mark's wave begins only when motion is allowed, and without it
// (or without SMIL) the flag rests flat.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

type Post = (request: TripRequest) => Promise<Itinerary>;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the band and the flag mark on the page", () => {
  it("opens both views with the band, and leads only the first screen's title with the flag", async () => {
    const user = userEvent.setup();
    const post: Post = async (request) => aiPlan(request);
    render(
      <PlannerApp
        loader={async () => tripData()}
        post={post}
        today={() => new Date(2026, 8, 23)}
      />,
    );
    const band = screen.getByTestId("tricolore");
    expect(band.getAttribute("aria-hidden")).toBe("true");
    expect([...band.children].map((part) => part.className)).toEqual([
      "tricolore-green",
      "tricolore-white",
      "tricolore-red",
    ]);
    // The band opens the page, above everything else in it.
    expect(band.parentElement?.firstElementChild).toBe(band);
    const title = screen.getByRole("heading", { level: 1, name: "3 Days in Italy" });
    const mark = screen.getByTestId("flag-mark");
    expect(title.firstElementChild).toBe(mark);
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("focusable")).toBe("false");

    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    expect(screen.getByTestId("tricolore")).toBe(band);
    expect(screen.queryByTestId("flag-mark")).toBeNull();
  });
});

describe("the flag mark's wave", () => {
  /** A browser that allows motion, or not. jsdom has no matchMedia of its own. */
  function motion(allowed: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: allowed && query.includes("no-preference"),
      media: query,
    }));
  }

  /** SMIL's beginElement, which jsdom lacks, on every SVG element for this test. */
  function smil() {
    const begin = vi.fn();
    Object.defineProperty(SVGElement.prototype, "beginElement", {
      value: begin,
      configurable: true,
      writable: true,
    });
    return begin;
  }

  afterEach(() => {
    delete (SVGElement.prototype as { beginElement?: unknown }).beginElement;
  });

  const state = () => screen.getByTestId("flag-mark").dataset.state;

  it("rests flat, with no wave, for a traveler who asked for reduced motion", async () => {
    motion(false);
    const begin = smil();
    render(<FlagMark />);
    // Past the moment the wave would begin, once the bands had drawn in.
    await act(async () => {});
    expect(state()).toBe("rest");
    expect(begin).not.toHaveBeenCalled();
  });

  it("rests flat when motion is turned off before the bands finish, even if their drawing is cut short", async () => {
    motion(true);
    const begin = smil();
    // The bands' drop-in, cancelled: its `finished` rejects, and the wave's turn comes anyway.
    Object.defineProperty(SVGSVGElement.prototype, "getAnimations", {
      value: () => [{ finished: Promise.reject(new DOMException("cancelled", "AbortError")) }],
      configurable: true,
    });
    try {
      render(<FlagMark />);
      motion(false);
      await act(async () => {});
      expect(state()).toBe("rest");
      expect(begin).not.toHaveBeenCalled();
    } finally {
      delete (SVGSVGElement.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("waves once when motion is allowed, every band together, then rests", async () => {
    motion(true);
    const begin = smil();
    render(<FlagMark />);
    await act(async () => {});
    expect(state()).toBe("waving");
    const mark = screen.getByTestId("flag-mark");
    const waves = mark.querySelectorAll("animate");
    // Three bands, the white band's two edges, the cloth under its light and its shade, and
    // every stop of those two gradients.
    expect(waves).toHaveLength(5 + 2 + 2 * SHADE_OFFSETS.length);
    expect(begin).toHaveBeenCalledTimes(waves.length);
    for (const wave of waves) {
      expect(wave.getAttribute("begin")).toBe("indefinite");
      expect(wave.getAttribute("calcMode")).toBe("linear");
      expect(wave.getAttribute("values")?.split(";")).toHaveLength(WAVE_FRAMES.length);
    }
    // The light and shade lie over the bands, each filled with its own gradient in this mark.
    const folds = [...mark.querySelectorAll(".flag-mark-fold")];
    expect(folds).toHaveLength(2);
    for (const fold of folds) {
      const id = fold.getAttribute("fill")?.match(/^url\(#(.+)\)$/)?.[1];
      expect(mark.querySelector(`linearGradient[id="${id}"]`)).not.toBeNull();
    }
    expect(mark.lastElementChild).toBe(folds[1]);
    // Every stop sits at nothing until the wind comes.
    for (const stop of mark.querySelectorAll("stop")) {
      expect(stop.getAttribute("stop-opacity")).toBe("0");
    }
    await act(async () => {
      must(waves[0]).dispatchEvent(new Event("endEvent"));
    });
    expect(state()).toBe("rest");
  });

  it("keeps waving while a mouse rests on it, then finishes the breath and rests", async () => {
    motion(true);
    const begin = smil();
    render(<FlagMark />);
    await act(async () => {});
    const mark = screen.getByTestId("flag-mark");
    const waves = mark.querySelectorAll("animate");
    const breath = () => must(waves[0]).dispatchEvent(new Event("endEvent"));
    await act(async () => breath());
    expect(state()).toBe("rest");
    begin.mockClear();
    // A mouse arrives: a breath begins at once, and each end begins the next.
    await act(async () => {
      mark.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    });
    expect(state()).toBe("waving");
    expect(begin).toHaveBeenCalledTimes(waves.length);
    await act(async () => breath());
    expect(state()).toBe("waving");
    expect(begin).toHaveBeenCalledTimes(2 * waves.length);
    // The mouse leaves mid-breath: that breath finishes, then the flag rests.
    await act(async () => {
      mark.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    });
    expect(state()).toBe("waving");
    await act(async () => breath());
    expect(state()).toBe("rest");
    expect(begin).toHaveBeenCalledTimes(2 * waves.length);
  });

  it("does not keep waving for a touch, which never leaves", async () => {
    motion(true);
    const begin = smil();
    render(<FlagMark />);
    await act(async () => {});
    const mark = screen.getByTestId("flag-mark");
    await act(async () => must(mark.querySelector("animate")).dispatchEvent(new Event("endEvent")));
    begin.mockClear();
    await act(async () => {
      mark.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    });
    expect(state()).toBe("rest");
    expect(begin).not.toHaveBeenCalled();
  });

  it("does not wave on hover for a traveler who asked for reduced motion", async () => {
    motion(false);
    const begin = smil();
    render(<FlagMark />);
    await act(async () => {});
    const mark = screen.getByTestId("flag-mark");
    await act(async () => {
      mark.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    });
    expect(state()).toBe("rest");
    expect(begin).not.toHaveBeenCalled();
  });

  it("rests flat where SMIL is missing", async () => {
    motion(true);
    render(<FlagMark />);
    await act(async () => {});
    expect(state()).toBe("rest");
  });

  it("does nothing once it has left the page before the bands finish drawing", async () => {
    motion(true);
    const begin = smil();
    const { unmount } = render(<FlagMark />);
    unmount();
    await act(async () => {});
    expect(begin).not.toHaveBeenCalled();
  });
});
