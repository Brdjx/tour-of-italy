import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DayMapInner from "../components/DayMapInner";
import { DISC_REACH, EXPAND_CLEAR } from "../components/map/camera";
import type { DayMapInnerProps } from "../components/map/types";
import { type MapPoint, mapDayTitle, mapPoints, stopLabel } from "../lib/mapPoints";
import { buildTripView } from "../lib/timetable";
import type { FindOpener, StopRef } from "../lib/useStopDetails";
import * as fake from "./fakeMapLibre";
import { lastMap } from "./fakeMapLibre";
import { ctx, fixturePlan, must } from "./fixtures";

// The map's stops and its full-screen view. Each stop is a button named like its row; hovering
// or focusing it shows a popup with its number, place, times and role, and the popup (or Enter,
// or a click) opens the stop's details. "Expand map" moves the same map into a dialog that fills
// the screen, with the day, the stop count and a day switcher; Close map, Escape and the
// browser's own close request bring it back, and focus returns to Expand map.

vi.mock("maplibre-gl", async () => (await import("./fakeMapLibre")).maplibre);

const days = buildTripView(fixturePlan(), ctx, []);
const options = days.map((day) => ({
  index: day.index,
  label: `Day ${day.index + 1}`,
  name: mapDayTitle(day),
}));

function dayPoints(index: number): MapPoint[] {
  return mapPoints(must(days[index]).day, ctx);
}

/** The first day's stop a marker opens: where it is in the day's order, and its place. */
function stopRef(marker: number): StopRef {
  const point = must(dayPoints(0)[marker]);
  return { index: point.number - 1, placeId: point.placeId };
}

function renderMap(props: Partial<DayMapInnerProps> = {}) {
  const handlers = { onSelectDay: vi.fn(), onDetails: vi.fn() };
  const all: DayMapInnerProps = {
    points: dayPoints(0),
    title: mapDayTitle(must(days[0])),
    days: options,
    active: 0,
    ...handlers,
    ...props,
  };
  const utils = render(<DayMapInner {...all} />);
  return {
    ...utils,
    ...handlers,
    user: userEvent.setup(),
    show: (next: Partial<DayMapInnerProps>) => utils.rerender(<DayMapInner {...all} {...next} />),
  };
}

const stops = () => screen.getAllByTestId("map-stop");
const popup = () => screen.queryByTestId("map-popup");
const dialog = () => screen.getByTestId("map-dialog") as HTMLDialogElement;
const canvas = () => must(document.querySelector<HTMLElement>(".map-canvas"), "the map");

/** jsdom never says focus came from the keyboard; the browser does, for Tab and arrow keys. */
function keyboardFocus() {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    if (selector === ":focus-visible") return this === document.activeElement;
    return matches.call(this, selector);
  });
}

/** Web Animations that report finished when `done` settles, as the browser's do. */
function stubAnimate(done: Promise<void> = Promise.resolve()) {
  const animate = vi.fn(() => ({ finished: done, cancel: vi.fn(), finish: vi.fn() }));
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
    writable: true,
  });
  return animate;
}

/** Lays out the map (the MapLibre container) and its stops, which jsdom does not. */
function layOut(map: { width: number; height: number }, centres: { x: number; y: number }[]) {
  const box = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }) as DOMRect;
  vi.spyOn(canvas(), "getBoundingClientRect").mockReturnValue(box(0, 0, map.width, map.height));
  stops().forEach((stop, index) => {
    const host = must(stop.closest(".map-stop")?.parentElement);
    const at = centres[index] ?? { x: -1000, y: -1000 };
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(at.x - 22, at.y - 22, 44, 44));
  });
}

/** Every popup measures `width` by `height`. */
function popupSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
}

/** A touch event as the browser sends it, with where each finger is. */
function touch(
  target: Element,
  type: "touchstart" | "touchend" | "touchcancel",
  at: { x: number; y: number },
  down = type === "touchstart" ? 1 : 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 0, target, clientX: at.x, clientY: at.y };
  Object.defineProperties(event, {
    touches: { value: Array.from({ length: down }, () => point) },
    changedTouches: { value: [point] },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  fake.resetFake();
  vi.stubGlobal("WebGL2RenderingContext", class {});
  fake.stubMedia();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--spring-smooth");
});

describe("the map's stops", () => {
  it("names every stop like its row: number, place, times, and the meal when it is one", () => {
    renderMap();
    const points = dayPoints(0);
    expect(stops().map((stop) => stop.getAttribute("aria-label"))).toEqual(points.map(stopLabel));
    const lunch = must(
      points.find((point) => point.role === "lunch"),
      "a lunch stop",
    );
    expect(
      screen.getByRole("button", { name: stopLabel(lunch) }).getAttribute("aria-label"),
    ).toMatch(/^Stop \d+, .+, \d\d:\d\d to \d\d:\d\d, lunch$/);
    // The stops come in visiting order, so Tab visits them in the board's order.
    expect(stops().map((stop) => stop.textContent)).toEqual(points.map((p) => String(p.number)));
  });

  it("renders a place name as text, never as markup", () => {
    const point = { ...must(dayPoints(0)[0]), name: '<img src=x onerror="alert(1)">' };
    renderMap({ points: [point] });
    expect(document.querySelector(".map-canvas img")).toBeNull();
    expect(stops()[0]?.getAttribute("aria-label")).toContain('<img src=x onerror="alert(1)">');
  });

  it("shows a stop's popup after a short hover, with its number, place, times and role", async () => {
    const { user } = renderMap();
    const point = must(dayPoints(0)[1]);
    await user.hover(must(stops()[1]));
    // Like a tooltip, not at once.
    expect(popup()).toBeNull();
    const shown = await screen.findByTestId("map-popup");
    expect(shown.getAttribute("aria-label")).toBe(`Details for ${point.name}`);
    expect(shown.querySelector(".map-popup-number")?.textContent).toBe(String(point.number));
    expect(shown.querySelector(".map-popup-name")?.textContent).toBe(point.name);
    expect(shown.querySelector(".map-popup-times")?.textContent).toMatch(
      /^\d\d:\d\d to \d\d:\d\d$/,
    );
    expect(shown.querySelector(".map-popup-role")?.textContent).toMatch(/^(Visit|Lunch|Dinner)$/);
    expect(shown.textContent).toContain("Details");
    // It sits in its stop's element, which draws above every other stop while it shows.
    const host = must(stops()[1]?.closest(".map-stop")?.parentElement);
    expect(host.contains(shown)).toBe(true);
    expect(Number(host.style.zIndex)).toBeGreaterThan(stops().length);
    expect(shown.dataset.placed).toBe("true");
    await user.unhover(must(stops()[1]));
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("keeps the popup while the pointer moves from the stop into it", async () => {
    const { user } = renderMap();
    await user.hover(must(stops()[0]));
    const shown = await screen.findByTestId("map-popup");
    await user.hover(shown);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(popup()).toBe(shown);
  });

  it("moves straight to the next stop's popup when the pointer does", async () => {
    const { user } = renderMap();
    await user.hover(must(stops()[0]));
    await screen.findByTestId("map-popup");
    await user.hover(must(stops()[2]));
    expect(popup()?.getAttribute("aria-label")).toBe(`Details for ${dayPoints(0)[2]?.name}`);
  });

  it("opens the stop's details from its popup, handing over the stop to return focus to", async () => {
    const { user, onDetails } = renderMap();
    await user.hover(must(stops()[1]));
    await user.click(await screen.findByTestId("map-popup"));
    expect(onDetails).toHaveBeenCalledWith(stopRef(1), stops()[1], expect.any(Function));
    expect(popup()).toBeNull();
    // With it, the button of any other stop on this map, for the sheet to give focus back to
    // after the traveler steps to that stop; nothing for a place the map does not draw.
    const find = onDetails.mock.calls[0]?.[2] as FindOpener;
    expect(find(stopRef(3))).toBe(stops()[3]);
    // A stop the day's order moved under the sheet is found by its place.
    expect(find({ ...stopRef(3), index: 0 })).toBe(stops()[3]);
    expect(find({ index: 3, placeId: "place_none" })).toBeNull();
  });

  it("opens the details at once on a mouse click on the stop itself", async () => {
    const { user, onDetails } = renderMap();
    await user.click(must(stops()[2]));
    expect(onDetails).toHaveBeenCalledWith(stopRef(2), stops()[2], expect.any(Function));
  });

  it("shows the popup on keyboard focus, and Enter opens the details", async () => {
    keyboardFocus();
    const { user, onDetails } = renderMap();
    act(() => must(stops()[0]).focus());
    expect(popup()?.getAttribute("aria-label")).toBe(`Details for ${dayPoints(0)[0]?.name}`);
    await user.keyboard("{Enter}");
    expect(onDetails).toHaveBeenCalledWith(stopRef(0), stops()[0], expect.any(Function));
    // Focus leaving the stop takes the popup with it.
    act(() => must(stops()[1]).focus());
    act(() => screen.getByTestId("map-expand").focus());
    expect(popup()).toBeNull();
  });

  it("shows nothing on focus that did not come from the keyboard", () => {
    renderMap();
    act(() => must(stops()[0]).focus());
    expect(popup()).toBeNull();
  });

  it("on touch, a tap shows the popup and a second tap opens the details", () => {
    const { onDetails } = renderMap();
    const stop = must(stops()[1]);
    // A finger does not hover.
    fireEvent.pointerEnter(must(stop.closest(".map-stop")), { pointerType: "touch" });
    fireEvent.pointerDown(stop, { pointerType: "touch" });
    fireEvent.click(stop);
    expect(onDetails).not.toHaveBeenCalled();
    const shown = must(popup(), "the popup after a tap");
    fireEvent.pointerDown(shown, { pointerType: "touch" });
    fireEvent.click(shown);
    expect(onDetails).toHaveBeenCalledWith(stopRef(1), stop, expect.any(Function));
    // A second tap on the stop itself does the same.
    fireEvent.pointerDown(stop, { pointerType: "touch" });
    fireEvent.click(stop);
    expect(popup()).not.toBeNull();
    fireEvent.pointerDown(stop, { pointerType: "touch" });
    fireEvent.click(stop);
    expect(onDetails).toHaveBeenCalledTimes(2);
  });

  it("puts the popup away on Escape, on a press elsewhere, on a drag and on a new day", async () => {
    const { user, show } = renderMap();
    const open = async (index: number) => {
      await user.hover(must(stops()[index]));
      await screen.findByTestId("map-popup");
    };
    await open(0);
    await user.keyboard("{Escape}");
    expect(popup()).toBeNull();
    await open(1);
    fireEvent.pointerDown(document.body);
    expect(popup()).toBeNull();
    await open(2);
    act(() => lastMap().emit("movestart", { originalEvent: new MouseEvent("mousedown") }));
    expect(popup()).toBeNull();
    // The camera's own glides leave it be.
    await open(3);
    act(() => lastMap().emit("movestart", {}));
    expect(popup()).not.toBeNull();
    show({ points: dayPoints(1), title: mapDayTitle(must(days[1])), active: 1 });
    expect(popup()).toBeNull();
  });
});

describe("a stop's popup, placed and put away", () => {
  it("goes beside its stop when other stops crowd above and below it", async () => {
    const { user } = renderMap();
    popupSize(120, 60);
    // Stop 2 in the middle of a 400 by 300 map, stop 1 just above where its popup would sit
    // above, stop 3 just below where it would sit below; the rest far away.
    layOut({ width: 400, height: 300 }, [
      { x: 200, y: 60 },
      { x: 200, y: 150 },
      { x: 200, y: 240 },
    ]);
    await user.hover(must(stops()[1]));
    expect((await screen.findByTestId("map-popup")).dataset.side).toBe("right");
  });

  it("keeps off the route: a stretch across where it would sit above sends it below", async () => {
    const { user } = renderMap();
    popupSize(120, 60);
    layOut({ width: 400, height: 300 }, [
      { x: -1000, y: -1000 },
      { x: 200, y: 150 },
    ]);
    const route = [
      { x: 60, y: 100 },
      { x: 340, y: 100 },
    ];
    lastMap().project = (() => {
      let call = 0;
      return () => route[call++ % 2] as { x: number; y: number };
    })();
    await user.hover(must(stops()[1]));
    expect((await screen.findByTestId("map-popup")).dataset.side).toBe("below");
  });

  it("keeps clear of the Expand pill on the page's map", async () => {
    const { user } = renderMap();
    popupSize(120, 60);
    // Just below the pill's corner: above would sit on the pill.
    layOut({ width: 400, height: 300 }, [{ x: 330, y: 110 }]);
    await user.hover(must(stops()[0]));
    expect((await screen.findByTestId("map-popup")).dataset.side).toBe("below");
  });

  it("puts the popup away on an Escape pressed elsewhere, and lets that Escape through", async () => {
    const { user } = renderMap();
    // A note on the board has focus while the mouse rests on a stop.
    const note = document.createElement("button");
    document.body.append(note);
    const heard = vi.fn();
    note.addEventListener("keydown", (event) => heard(event.key, event.defaultPrevented));
    await user.hover(must(stops()[0]));
    await screen.findByTestId("map-popup");
    act(() => note.focus());
    await user.keyboard("{Escape}");
    expect(popup()).toBeNull();
    expect(heard).toHaveBeenCalledWith("Escape", false);
    note.remove();
  });

  it("keeps an Escape on the map to the popup", async () => {
    keyboardFocus();
    const { user } = renderMap();
    const beyond = vi.fn();
    window.addEventListener("keydown", beyond);
    try {
      act(() => must(stops()[0]).focus());
      expect(popup()).not.toBeNull();
      await user.keyboard("{Escape}");
      expect(popup()).toBeNull();
      expect(beyond).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", beyond);
    }
  });

  it("shows nothing for a finger's pointerenter, or for a mouse's on a device that cannot hover", async () => {
    renderMap();
    const stop = must(stops()[1]?.closest(".map-stop"));
    fireEvent.pointerEnter(stop, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(popup()).toBeNull();
    fireEvent.pointerLeave(stop, { pointerType: "touch" });
    cleanup();
    // A phone's browser sends a mouse's pointerenter where the last tap was when the layout
    // moves under it, after Close map say. That is no hover.
    fake.stubMedia({ hover: false });
    renderMap();
    fireEvent.pointerEnter(must(stops()[1]?.closest(".map-stop")), { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(popup()).toBeNull();
  });

  it("keeps a tap on a stop or its popup from the map, so a second tap is never a zoom", () => {
    renderMap();
    const reached: string[] = [];
    for (const type of ["touchend", "dblclick"]) {
      canvas().addEventListener(type, (event) => reached.push(event.type));
    }
    const stop = must(stops()[1]);
    // A tap, and a tap that wobbled a few px: MapLibre never hears them end.
    touch(stop, "touchstart", { x: 100, y: 100 });
    touch(stop, "touchend", { x: 100, y: 100 });
    touch(stop, "touchstart", { x: 100, y: 100 });
    touch(stop, "touchend", { x: 106, y: 104 });
    fireEvent.pointerDown(stop, { pointerType: "touch" });
    fireEvent.click(stop);
    const shown = must(popup(), "the popup after a tap");
    touch(shown, "touchstart", { x: 100, y: 60 });
    touch(shown, "touchend", { x: 100, y: 60 });
    fireEvent.dblClick(stop);
    expect(reached).toEqual([]);
    // A drag that starts on a stop is the map's: it pans, and hears the drag end.
    touch(stop, "touchstart", { x: 100, y: 100 });
    touch(stop, "touchend", { x: 140, y: 100 });
    expect(reached).toEqual(["touchend"]);
    // So is a pinch with a finger on a stop.
    touch(stop, "touchstart", { x: 100, y: 100 });
    touch(stop, "touchstart", { x: 100, y: 100 }, 2);
    touch(stop, "touchend", { x: 100, y: 100 }, 1);
    touch(stop, "touchend", { x: 100, y: 100 });
    expect(reached).toEqual(["touchend", "touchend", "touchend"]);
    // A touch the browser took over (it scrolled, say) ends as the map's too.
    touch(stop, "touchstart", { x: 100, y: 100 });
    touch(stop, "touchcancel", { x: 100, y: 100 });
    touch(stop, "touchend", { x: 100, y: 100 });
    expect(reached).toEqual(["touchend", "touchend", "touchend", "touchend"]);
  });

  it("leaves no timer and no listener behind when the map goes mid-hover or with a popup", async () => {
    const setTimer = vi.spyOn(window, "setTimeout");
    const clearTimer = vi.spyOn(window, "clearTimeout");
    const first = renderMap();
    fireEvent.pointerEnter(must(stops()[1]?.closest(".map-stop")), { pointerType: "mouse" });
    const hover = setTimer.mock.calls.findIndex(([, delay]) => delay === 250);
    expect(hover).toBeGreaterThanOrEqual(0);
    first.unmount();
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[hover]?.value);
    cleanup();

    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { user, unmount } = renderMap();
    await user.hover(must(stops()[0]));
    await screen.findByTestId("map-popup");
    const onPress = add.mock.calls.find(([type, , capture]) => type === "pointerdown" && capture);
    expect(onPress).toBeTruthy();
    unmount();
    expect(remove).toHaveBeenCalledWith("pointerdown", onPress?.[1], true);
  });
});

describe("the full-screen map", () => {
  it("opens the day's map full screen: the same map, moved into a dialog", async () => {
    const { user } = renderMap();
    const map = lastMap();
    const expand = screen.getByRole("button", { name: "Expand map" });
    expect(expand.getAttribute("aria-haspopup")).toBe("dialog");
    expect(dialog().open).toBe(false);
    await user.click(expand);
    expect(dialog().open).toBe(true);
    expect(expand.getAttribute("aria-controls")).toBe(dialog().id);
    // One map: its container now sits in the dialog, and the page's frame is empty.
    expect(dialog().contains(canvas())).toBe(true);
    expect(screen.getByTestId("map-host").childElementCount).toBe(0);
    expect(fake.state.maps).toHaveLength(1);
    expect(map.resize).toHaveBeenCalled();
    // Full screen, the map takes one-finger drags and the wheel; there is no page to scroll.
    expect(map.cooperativeGestures.disable).toHaveBeenCalled();
    // The heading names the day and takes focus; the stops are counted under it.
    const title = screen.getByTestId("map-dialog-title");
    expect(title.textContent).toBe(mapDayTitle(must(days[0])));
    expect(document.activeElement).toBe(title);
    expect(dialog().getAttribute("aria-labelledby")).toBe(title.id);
    expect(within(dialog()).getByText(`${dayPoints(0).length} stops, numbered in visiting order`));
    // The camera frames the day for the bigger map, with room for the day switcher at the foot.
    const [bounds, options] = map.fitBounds.mock.calls.at(-1) ?? [];
    expect(bounds).toBeTruthy();
    expect(options).toMatchObject({ maxZoom: 15, duration: 700 });
    expect(options.padding).toMatchObject({ top: 40 });
    // The stops are in the dialog too, still buttons.
    expect(within(dialog()).getAllByTestId("map-stop")).toHaveLength(dayPoints(0).length);
  });

  it("closes with Close map, putting the map back and focus on Expand map", async () => {
    const { user } = renderMap();
    const map = lastMap();
    const expand = screen.getByRole("button", { name: "Expand map" });
    await user.click(expand);
    await user.click(screen.getByRole("button", { name: "Close map" }));
    await waitFor(() => expect(dialog().open).toBe(false));
    expect(screen.getByTestId("map-host").contains(canvas())).toBe(true);
    expect(map.cooperativeGestures.enable).toHaveBeenCalled();
    expect(document.activeElement).toBe(expand);
    // The camera settles on the page's framing as it goes.
    expect(map.fitBounds.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 340 });
  });

  it("closes with Escape", async () => {
    const { user } = renderMap();
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog().open).toBe(false));
    expect(document.activeElement).toBe(screen.getByTestId("map-expand"));
  });

  it("puts away a popup from the page's map as it opens", async () => {
    const { user } = renderMap();
    await user.hover(must(stops()[0]));
    await screen.findByTestId("map-popup");
    // From the keyboard, so no press elsewhere puts the popup away first.
    act(() => screen.getByTestId("map-expand").focus());
    await user.keyboard("{Enter}");
    expect(dialog().open).toBe(true);
    expect(popup()).toBeNull();
  });

  it("resizes the map where it lands: in the dialog, again once it has grown, and on the page", async () => {
    let grown = () => {};
    const growing = new Promise<void>((resolve) => {
      grown = resolve;
    });
    stubAnimate(growing);
    try {
      const { user } = renderMap();
      const map = lastMap();
      const places: string[] = [];
      map.resize.mockImplementation(() => {
        places.push(dialog().contains(canvas()) ? "full" : "page");
      });
      await user.click(screen.getByRole("button", { name: "Expand map" }));
      expect(places).toEqual(["full"]);
      // The tiles fill the final size once the grow has finished.
      grown();
      await waitFor(() => expect(places).toEqual(["full", "full"]));
      await user.click(screen.getByRole("button", { name: "Close map" }));
      await waitFor(() => expect(dialog().open).toBe(false));
      expect(places.at(-1)).toBe("page");
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("frames the day with room for the day switcher, and keeps a popup clear of it", async () => {
    const { user } = renderMap();
    const map = lastMap();
    // The stage is 300 px tall and the switcher starts 220 px down: 80 px at the foot are its.
    const stage = must(dialog().querySelector<HTMLElement>(".map-dialog-stage"));
    const switcher = screen.getByTestId("map-days");
    Object.defineProperty(stage, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(switcher, "offsetTop", { value: 220, configurable: true });
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    expect(map.fitBounds.mock.calls.at(-1)?.[1].padding.bottom).toBe(80 + DISC_REACH);
    // A stop 112 px down a 300 by 300 map: its popup does not fit above, and below it would sit
    // on the switcher, so it goes above, the less of it cut off.
    popupSize(200, 90);
    layOut({ width: 300, height: 300 }, [{ x: 150, y: 112 }]);
    const first = must(within(dialog()).getAllByTestId("map-stop")[0]);
    await user.hover(first);
    expect((await screen.findByTestId("map-popup")).dataset.side).toBe("above");
    await user.unhover(first);
    await waitFor(() => expect(popup()).toBeNull());
    // Without the switcher it fits below.
    Object.defineProperty(switcher, "offsetTop", { value: 300, configurable: true });
    await user.hover(first);
    expect((await screen.findByTestId("map-popup")).dataset.side).toBe("below");
  });

  it("keeps the stops and a popup clear of the notch in landscape", async () => {
    const { user } = renderMap();
    const map = lastMap();
    // The header's side padding is the gutter or the notch, whichever is wider.
    const head = must(dialog().querySelector<HTMLElement>(".map-dialog-head"));
    head.style.paddingLeft = "47px";
    head.style.paddingRight = "47px";
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    expect(map.fitBounds.mock.calls.at(-1)?.[1].padding).toMatchObject({ left: 87, right: 87 });
    // A stop 22 px from the left edge: its popup slides right until it clears the notch.
    popupSize(200, 90);
    layOut({ width: 400, height: 300 }, [{ x: 22, y: 172 }]);
    await user.hover(must(within(dialog()).getAllByTestId("map-stop")[0]));
    const shown = await screen.findByTestId("map-popup");
    expect(shown.dataset.side).toBe("above");
    expect(22 - 100 + Number.parseFloat(shown.style.getPropertyValue("--shift"))).toBe(47 + 8);
  });

  it("closes a stop's popup first with Escape, then the full-screen map", async () => {
    const { user } = renderMap();
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    await user.hover(must(within(dialog()).getAllByTestId("map-stop")[0]));
    await screen.findByTestId("map-popup");
    await user.keyboard("{Escape}");
    expect(popup()).toBeNull();
    expect(dialog().open).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog().open).toBe(false));
  });

  it("answers the browser's own close request with its motion, and a close it forced at once", async () => {
    const { user } = renderMap();
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog(), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await waitFor(() => expect(dialog().open).toBe(false));
    // A browser that closed the dialog without asking: the map comes straight back.
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    dialog().removeAttribute("open");
    fireEvent(dialog(), new Event("close"));
    expect(screen.getByTestId("map-host").contains(canvas())).toBe(true);
    expect(dialog().dataset.state).toBeUndefined();
  });

  it("switches days from full screen through the page's own day selection", async () => {
    const { user, onSelectDay, show } = renderMap();
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    const switcher = screen.getByRole("group", { name: "Trip days" });
    const second = within(switcher).getByRole("radio", { name: mapDayTitle(must(days[1])) });
    expect(within(switcher).getByRole("radio", { checked: true })).toBeTruthy();
    await user.click(second);
    expect(onSelectDay).toHaveBeenCalledWith(1);
    const map = lastMap();
    show({ points: dayPoints(1), title: mapDayTitle(must(days[1])), active: 1 });
    expect(screen.getByTestId("map-dialog-title").textContent).toBe(mapDayTitle(must(days[1])));
    expect((second as HTMLInputElement).checked).toBe(true);
    // The camera glides to the new day with the full-screen framing, and the map stays put.
    expect(map.fitBounds.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 700 });
    expect(dialog().open).toBe(true);
  });

  it("grows out of the page's box with transforms only, on the page's spring", async () => {
    document.documentElement.style.setProperty("--spring-smooth", "linear(0, 0.5 20%, 1)");
    const animate = vi.fn(() => ({
      finished: Promise.resolve(),
      cancel: vi.fn(),
      finish: vi.fn(),
    }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      value: animate,
      configurable: true,
      writable: true,
    });
    try {
      const { user } = renderMap();
      await user.click(screen.getByRole("button", { name: "Expand map" }));
      const [frame, inner] = animate.mock.calls as unknown as [
        [Keyframe[], KeyframeAnimationOptions],
        [Keyframe[], KeyframeAnimationOptions],
      ];
      expect(frame[1]).toMatchObject({ duration: 450, easing: "linear(0, 0.5 20%, 1)" });
      expect(frame[0].every((keyframe) => Object.keys(keyframe).join() === "transform")).toBe(true);
      expect(frame[0].at(-1)?.transform).toBe("translate(0px, 0px) scale(1, 1)");
      expect(inner[0].at(-1)?.transform).toBe("scale(1, 1) translate(0px, 0px)");
      animate.mockClear();
      await user.click(screen.getByRole("button", { name: "Close map" }));
      await waitFor(() => expect(dialog().open).toBe(false));
      const [shrink] = animate.mock.calls as unknown as [[Keyframe[], KeyframeAnimationOptions]];
      // It shrinks back from full screen, a little quicker, and holds its last frame until the
      // map is back on the page.
      expect(shrink[0][0]?.transform).toBe("translate(0px, 0px) scale(1, 1)");
      expect(shrink[1]).toMatchObject({ duration: 340, fill: "forwards" });
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("fades in and out instead when the traveler prefers reduced motion", async () => {
    fake.stubMedia({ reduced: true });
    const animate = vi.fn(() => ({
      finished: Promise.resolve(),
      cancel: vi.fn(),
      finish: vi.fn(),
    }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      value: animate,
      configurable: true,
      writable: true,
    });
    try {
      const { user } = renderMap();
      const map = lastMap();
      await user.click(screen.getByRole("button", { name: "Expand map" }));
      const calls = animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(calls[0]?.[1]).toMatchObject({ duration: 180 });
      // The camera jumps rather than glides.
      expect(map.fitBounds.mock.calls.at(-1)?.[1]).toMatchObject({ animate: false });
      await user.click(screen.getByRole("button", { name: "Close map" }));
      // The camera jumps back to the page's framing too.
      expect(map.fitBounds.mock.calls.at(-1)?.[1]).toMatchObject({ animate: false });
      await waitFor(() => expect(dialog().open).toBe(false));
      expect(calls.at(-1)?.[0]).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("frames the page's map lower when a stop would sit under the Expand pill", () => {
    const size = { clientWidth: 360, clientHeight: 280 };
    for (const [name, value] of Object.entries(size)) {
      vi.spyOn(HTMLElement.prototype, name as "clientWidth", "get").mockReturnValue(value);
    }
    const point = must(dayPoints(0)[0]);
    // MapLibre's even framing would put this stop 20 px from the top right corner.
    const scale = 512 * 2 ** 14;
    const cos = Math.cos((point.lat * Math.PI) / 180);
    fake.state.camera = {
      center: {
        lng: point.lng - ((340 - 180) / scale) * 360,
        lat: point.lat - ((140 - 20) / scale) * 360 * cos,
      },
      zoom: 14,
    };
    renderMap({ points: [point] });
    const [, options] = lastMap().fitBounds.mock.calls[0] ?? [];
    expect(options).toEqual({
      padding: { top: EXPAND_CLEAR, right: 40, bottom: 40, left: 40 },
      maxZoom: 15,
      animate: false,
    });
    // A day with nothing in that corner keeps the even frame.
    cleanup();
    fake.state.camera = { center: { lng: point.lng, lat: point.lat }, zoom: 14 };
    renderMap({ points: [point] });
    expect(lastMap().fitBounds).not.toHaveBeenCalled();
  });

  it("takes its dialog with it when the map goes", async () => {
    const { user, unmount } = renderMap();
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    unmount();
    expect(screen.queryByTestId("map-dialog")).toBeNull();
    expect(document.querySelector(".map-canvas")).toBeNull();
  });
});
