import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayTimetable, detailsButtonFor } from "../components/DayTimetable";
import { PlacePhotoImage } from "../components/PlacePhotoImage";
import { type PlacePhoto, photoForPlace } from "../lib/placePhotos";
import { buildDayView, type DayView, type RowView } from "../lib/timetable";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useStopDetails } from "../lib/useStopDetails";
import { ctx, fixturePlan, must } from "./fixtures";

// Previous and Next in a stop's details sheet step through the day's stops, meals included,
// without closing it: the pills (at the foot on phones, beside Close from 768 px), the arrow
// keys, and a sideways swipe on touch. Each step slides the new stop in from its side, says
// where the sheet is now, and marks that stop as the one open on the board. Closing gives focus
// to the stop now shown.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const plan = fixturePlan();
const day = must(buildDayView(plan, 0, ctx, []));
const count = day.rows.length;

function renderDay(view: DayView = day) {
  const user = userEvent.setup();
  const handlers = { onSwap: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() };
  render(<DayTimetable view={view} animate={false} changedStop={null} {...handlers} />);
  return { user };
}

const sheet = () => screen.getByTestId("details-sheet") as HTMLDialogElement;
const title = () => screen.getByTestId("details-title").textContent;
const next = () => screen.getByTestId("details-next");
const previous = () => screen.getByTestId("details-previous");
const position = () => screen.getByTestId("details-position").textContent;
const announced = () => screen.getByTestId("details-announcement").textContent;

function rowElement(row: RowView): HTMLElement {
  return must(
    screen.getAllByTestId("stop-row").find((item) => item.dataset.placeId === row.stop.placeId),
    "row on the board",
  );
}

function detailsOf(row: RowView): HTMLElement {
  return within(rowElement(row)).getByTestId("details-button");
}

const row = (index: number) => must(day.rows[index], `stop ${index + 1}`);

/** matchMedia that answers `matches` for the queries given, and lets a test change them. */
function stubMedia(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return state[query] ?? false;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    set(query: string, value: boolean) {
      state[query] = value;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

describe("stepping through a day's stops in the details sheet", () => {
  it("goes to the next and the previous stop, meals included, and says which of the day's it is", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    expect(title()).toBe(row(0).place?.name);
    expect(position()).toBe(`Stop 1 of ${count}`);
    await user.click(next());
    // The second stop is lunch: a meal is a stop like any other.
    expect(row(1).stop.role).toBe("lunch");
    expect(title()).toBe(row(1).place?.name);
    expect(position()).toBe(`Stop 2 of ${count}`);
    expect(within(sheet()).getByTestId("meal-label").textContent).toBe("Lunch");
    const visit = must(sheet().querySelector('[data-fact="visit"] dd'), "the visit's times");
    expect(visit.textContent).toContain("13:05");
    await user.click(next());
    expect(title()).toBe(row(2).place?.name);
    await user.click(previous());
    await user.click(previous());
    expect(title()).toBe(row(0).place?.name);
    expect(sheet().open).toBe(true);
  });

  it("loads the photos a step away while the sheet is open", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(1)));
    const preloaded = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"]')];
    for (const near of [row(0), row(2)]) {
      const photo = must(near.place ? photoForPlace(near.place) : null, "a photo a step away");
      // With a srcset the browser picks the size, so React leaves the plain href out.
      const link = must(
        preloaded.find((item) => item.getAttribute("imagesrcset") === photo.srcSet),
      );
      expect(link.getAttribute("as")).toBe("image");
      expect(link.getAttribute("imagesizes")).toBe("(min-width: 768px) 504px, calc(100vw - 32px)");
    }
  });

  it("names each pill by its direction alone, so a step never renames the focused pill", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(1)));
    expect(previous().getAttribute("aria-label")).toBe("Previous stop");
    expect(next().getAttribute("aria-label")).toBe("Next stop");
    // The words on the pills are in their names (label in name).
    expect(previous().textContent).toBe("Previous");
    expect(next().textContent).toBe("Next");
    // A screen reader reads a new name on the focused control out at once; the stop arrived at
    // is the live region's to say, so the name stays as it was.
    await user.click(next());
    expect(next().getAttribute("aria-label")).toBe("Next stop");
    expect(announced()).toContain(row(2).place?.name);
    await user.click(previous());
    await user.click(previous());
    expect(previous().getAttribute("aria-label")).toBe("Previous stop");
  });

  it("dims Previous at the first stop and Next at the last, in place, focusable and doing nothing", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    expect(previous().getAttribute("aria-disabled")).toBe("true");
    expect(previous().hasAttribute("disabled")).toBe(false);
    expect(next().hasAttribute("aria-disabled")).toBe(false);
    await user.click(previous());
    expect(title()).toBe(row(0).place?.name);
    for (let step = 1; step < count; step += 1) await user.click(next());
    expect(title()).toBe(row(count - 1).place?.name);
    expect(position()).toBe(`Stop ${count} of ${count}`);
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(next().getAttribute("aria-label")).toBe("Next stop");
    expect(previous().hasAttribute("aria-disabled")).toBe(false);
    // Pressed at the end, it keeps focus and the sheet stays on the last stop.
    await user.click(next());
    expect(document.activeElement).toBe(next());
    expect(title()).toBe(row(count - 1).place?.name);
  });

  it("keeps focus on the pill that stepped, from the keyboard too", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(2)));
    await user.click(next());
    expect(document.activeElement).toBe(next());
    act(() => previous().focus());
    await user.keyboard("{Enter}");
    expect(title()).toBe(row(2).place?.name);
    expect(document.activeElement).toBe(previous());
    await user.keyboard(" ");
    expect(title()).toBe(row(1).place?.name);
    expect(document.activeElement).toBe(previous());
  });

  it("steps with the arrow keys wherever focus is in the sheet, and leaves focus there", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const heading = screen.getByTestId("details-title");
    expect(document.activeElement).toBe(heading);
    await user.keyboard("{ArrowRight}");
    expect(title()).toBe(row(1).place?.name);
    expect(document.activeElement).toBe(heading);
    const close = screen.getByTestId("details-close");
    act(() => close.focus());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(title()).toBe(row(3).place?.name);
    expect(document.activeElement).toBe(close);
    await user.keyboard("{ArrowLeft}");
    expect(title()).toBe(row(2).place?.name);
    // An arrow with a modifier is the browser's (Alt+Left is Back), and other keys do nothing.
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}{ArrowDown}{Home}");
    expect(title()).toBe(row(2).place?.name);
  });

  it("leaves the arrows to a field that takes text", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const field = document.createElement("input");
    sheet().append(field);
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(title()).toBe(row(0).place?.name);
    // An arrow some control inside has already used is left alone too.
    const heading = screen.getByTestId("details-title");
    heading.addEventListener("keydown", (event) => event.preventDefault());
    fireEvent.keyDown(heading, { key: "ArrowRight" });
    expect(title()).toBe(row(0).place?.name);
    await user.click(next());
    expect(title()).toBe(row(1).place?.name);
  });

  it("gives focus to the title when the part holding it steps away", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const link = must(sheet().querySelector<HTMLAnchorElement>(".photo-credit a"), "a credit link");
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    await user.keyboard("{ArrowRight}");
    expect(link.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId("details-title"));
  });

  it("says where it is after each step, in a live region of its own, and nothing on opening", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const region = screen.getByTestId("details-announcement");
    expect(sheet().contains(region)).toBe(true);
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(announced()).toBe("");
    await user.click(next());
    expect(announced()).toBe(`Stop 2 of ${count}, Roscioli Salumeria, 13:05 to 14:35, lunch`);
    const first = region.firstElementChild;
    await user.click(previous());
    expect(announced()).toBe(`Stop 1 of ${count}, ${row(0).place?.name}, 09:45 to 12:45`);
    // A new node for each step, so the same words said again are heard again.
    expect(region.firstElementChild).not.toBe(first);
  });

  it("marks the stop shown as the one open on the board", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    expect(detailsOf(row(0)).getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(detailsOf(row(0)).getAttribute("aria-expanded")).toBe("false");
    expect(detailsOf(row(1)).getAttribute("aria-expanded")).toBe("true");
  });

  it("closes onto the Details of the stop it shows, brought into view when it is off screen", async () => {
    // jsdom lays nothing out: the page scrolls where it is told, and the rows are placed by hand.
    const scroll = vi.fn(({ top }: { top: number }) => vi.stubGlobal("scrollY", top));
    vi.stubGlobal("scrollTo", scroll);
    const place = (element: HTMLElement, top: number) =>
      Object.defineProperties(element, {
        offsetTop: { value: top, configurable: true },
        offsetHeight: { value: 44, configurable: true },
      });
    const { user } = renderDay();
    const target = detailsOf(row(4));
    place(target, 2000);
    await user.click(detailsOf(row(1)));
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(title()).toBe(row(4).place?.name);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(target);
    // To the middle of the screen (768 px tall here), measured as laid out: the drawn box of a
    // page scaled back behind the sheet is nearer the top than the page it comes back to.
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ top: 2000 + 22 - 384, behavior: "instant" });
    // The page scales back from around the top of what it shows now, so it grows in place.
    expect(document.documentElement.style.getPropertyValue("--recede-top")).toBe("1638px");
    // A stop already on screen is not scrolled to.
    place(detailsOf(row(3)), 1638 + 300);
    await user.click(detailsOf(row(4)));
    await user.keyboard("{ArrowLeft}");
    await user.click(screen.getByTestId("details-close"));
    expect(document.activeElement).toBe(detailsOf(row(3)));
    expect(scroll).toHaveBeenCalledTimes(1);
    document.documentElement.style.removeProperty("--recede-top");
  });

  it("closes back onto the photo that opened it when it is on that stop again", async () => {
    const { user } = renderDay();
    const thumb = must(screen.queryAllByTestId("stop-thumb")[0], "a highlight photo");
    await user.click(thumb);
    await user.keyboard("{ArrowRight}{ArrowLeft}");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(thumb);
  });

  it("closes onto what opened it when the stop shown has no Details on the board", async () => {
    // A place no longer in the data has no photo and no Details, but it is still a stop.
    const gone: RowView = { ...row(1), place: undefined };
    const { user } = renderDay({
      ...day,
      rows: day.rows.map((item) => (item === row(1) ? gone : item)),
    });
    const opener = detailsOf(row(0));
    await user.click(opener);
    await user.keyboard("{ArrowRight}");
    expect(title()).toBe("A place no longer in the data");
    expect(position()).toBe(`Stop 2 of ${count}`);
    expect(within(rowElement(gone)).queryByTestId("details-button")).toBeNull();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
  });

  it("slides the new stop in from the side it came from while the photo's frame stays", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const details = screen.getByTestId("stop-details");
    const heading = must(screen.getByTestId("details-title").parentElement);
    const frame = must(details.querySelector(".place-details-photo"), "the photo's frame");
    expect(details.dataset.stepped).toBeUndefined();
    expect(heading.dataset.stepped).toBeUndefined();
    const facts = within(details).getByTestId("stop-fact-sheet");
    const summary = within(details).getByTestId("place-summary");
    const credit = frame.querySelector("figcaption");
    await user.click(next());
    expect(details.dataset.stepped).toBe("true");
    expect(heading.dataset.stepped).toBe("true");
    expect(details.style.getPropertyValue("--from")).toBe("1");
    // New parts, so they slide in; the same frame, so the photo does not flash.
    expect(within(details).getByTestId("stop-fact-sheet")).not.toBe(facts);
    expect(within(details).getByTestId("place-summary")).not.toBe(summary);
    expect(frame.querySelector("figcaption")).not.toBe(credit);
    expect(details.querySelector(".place-details-photo")).toBe(frame);
    await user.click(previous());
    expect(details.style.getPropertyValue("--from")).toBe("-1");
    expect(heading.style.getPropertyValue("--from")).toBe("-1");
  });

  it("starts afresh each time it opens", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    await user.keyboard("{ArrowRight}");
    expect(announced()).not.toBe("");
    await user.keyboard("{Escape}");
    await user.click(detailsOf(row(3)));
    expect(position()).toBe(`Stop 4 of ${count}`);
    expect(announced()).toBe("");
    expect(screen.getByTestId("stop-details").dataset.stepped).toBeUndefined();
  });

  it("shows no steps for a day of one stop", async () => {
    const { user } = renderDay({ ...day, rows: [row(0)] });
    await user.click(detailsOf(row(0)));
    expect(screen.queryByTestId("details-steps")).toBeNull();
    expect(sheet().classList.contains("details-sheet--steps")).toBe(false);
    await user.keyboard("{ArrowRight}");
    expect(title()).toBe(row(0).place?.name);
  });
});

describe("the photo's frame between two stops", () => {
  const [a, b, c] = [row(0), row(2), row(3)].map((item) =>
    must(item.place ? photoForPlace(item.place) : null, "a photo"),
  ) as [PlacePhoto, PlacePhoto, PlacePhoto];
  const photo = (shown: PlacePhoto) => (
    <PlacePhotoImage photo={shown} shape="wide" sizes="100vw" eager />
  );
  const top = () =>
    must(document.querySelector<HTMLImageElement>(".place-photo-img:not(.place-photo-under)"));
  const under = () => screen.queryByTestId("photo-under");

  it("lays the last photo under the next and lets it go as the next fades in", async () => {
    const { rerender } = render(photo(a));
    fireEvent.load(top());
    rerender(photo(b));
    expect(under()?.getAttribute("src")).toBe(a.src);
    expect(under()?.getAttribute("alt")).toBe("");
    expect(under()?.getAttribute("aria-hidden")).toBe("true");
    expect(top().getAttribute("src")).toBe(b.src);
    expect(top().getAttribute("alt")).toBe(b.alt);
    expect(document.querySelector(".place-photo")?.getAttribute("data-state")).toBe("loading");
    fireEvent.load(top());
    expect(document.querySelector(".place-photo")?.getAttribute("data-state")).toBe("loaded");
    // It goes on its own time, not the new photo's (timetable.css fades it out after 120 ms).
    await waitFor(() => expect(under()).toBeNull());
  });

  it("lets the last photo go even when the next is slow, so no place wears another's photo", async () => {
    const { rerender } = render(photo(a));
    fireEvent.load(top());
    rerender(photo(b));
    // A third before the second arrives: the first, the last that arrived, is still the one under.
    rerender(photo(c));
    expect(under()?.getAttribute("src")).toBe(a.src);
    await waitFor(() => expect(under()).toBeNull());
    expect(document.querySelector(".place-photo")?.getAttribute("data-state")).toBe("loading");
  });

  it("keeps nothing under a photo when the last had not arrived or failed", () => {
    const { rerender } = render(photo(a));
    rerender(photo(b));
    expect(under()).toBeNull();
    fireEvent.error(top());
    expect(document.querySelector(".place-photo")?.getAttribute("data-state")).toBe("failed");
    rerender(photo(c));
    expect(under()).toBeNull();
    expect(document.querySelector(".place-photo")?.getAttribute("data-state")).toBe("loading");
  });
});

describe("where the step controls sit", () => {
  it("at the foot while the page is drawn on the server, where no width is known", () => {
    function Probe() {
      return <p>{useMediaQuery("(min-width: 768px)") ? "head" : "foot"}</p>;
    }
    stubMedia({ "(min-width: 768px)": true });
    expect(renderToString(<Probe />)).toBe("<p>foot</p>");
  });

  it("in a bar at the foot on phones, and beside Close from 768 px, as the width changes", async () => {
    const media = stubMedia({ "(min-width: 768px)": false });
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const foot = must(sheet().querySelector<HTMLElement>(".form-sheet-foot"), "the sheet's foot");
    expect(foot.contains(screen.getByTestId("details-steps"))).toBe(true);
    expect(within(foot).getByTestId("details-steps").classList).toContain("step-controls--foot");
    media.set("(min-width: 768px)", true);
    expect(sheet().querySelector(".form-sheet-foot")).toBeNull();
    const head = must(sheet().querySelector<HTMLElement>(".form-sheet-head"), "the sheet's head");
    const steps = within(head).getByTestId("details-steps");
    expect(steps.classList).toContain("step-controls--head");
    // Round pills beside Close: the words go, the names stay.
    expect(next().textContent).toBe("");
    expect(next().getAttribute("aria-label")).toBe("Next stop");
    expect(steps.nextElementSibling).toBe(screen.getByTestId("details-close"));
    await user.click(next());
    expect(title()).toBe(row(1).place?.name);
  });

  it("hands focus to the same pill in its new place as the width crosses 768 px", async () => {
    const media = stubMedia({ "(min-width: 768px)": false });
    const { user } = renderDay();
    await user.click(detailsOf(row(1)));
    const head = () => must(sheet().querySelector<HTMLElement>(".form-sheet-head"), "the head");
    // A window made wider (or a tablet turned, or a zoom out) moves the pills to the head.
    act(() => next().focus());
    media.set("(min-width: 768px)", true);
    expect(head().contains(next())).toBe(true);
    expect(document.activeElement).toBe(next());
    // And back to the foot, after a step as well.
    await user.click(previous());
    media.set("(min-width: 768px)", false);
    expect(head().contains(previous())).toBe(false);
    expect(document.activeElement).toBe(previous());
    // Focus anywhere else in the sheet stays where it is.
    const close = screen.getByTestId("details-close");
    act(() => close.focus());
    media.set("(min-width: 768px)", true);
    expect(document.activeElement).toBe(close);
    // A pill that had focus once but not last is not where focus goes.
    act(() => next().focus());
    act(() => screen.getByTestId("details-title").focus());
    media.set("(min-width: 768px)", false);
    expect(document.activeElement).toBe(screen.getByTestId("details-title"));
  });
});

describe("a day that visits one place twice", () => {
  // The planner reports a place visited twice rather than refusing it, so a day can hold it.
  const twice: RowView[] = [row(0), row(1), { ...row(0), index: 2 }, { ...row(2), index: 3 }];
  const stop = (at: number) => ({ index: at, placeId: must(twice[at]).stop.placeId });

  it("steps on past the second visit instead of back to the first", () => {
    const { result } = renderHook(() => useStopDetails(twice));
    const opener = document.createElement("button");
    act(() => result.current.control.open(stop(1), opener));
    act(() => result.current.sheet.steps.step(1));
    expect(result.current.control.openIndex).toBe(2);
    expect(result.current.sheet.row).toBe(twice[2]);
    expect(result.current.sheet.steps.next).toBe(twice[3]);
    act(() => result.current.sheet.steps.step(1));
    expect(result.current.sheet.row).toBe(twice[3]);
    act(() => result.current.sheet.steps.step(-1));
    expect(result.current.control.openIndex).toBe(2);
    act(() => result.current.sheet.steps.step(-1));
    expect(result.current.control.openIndex).toBe(1);
  });

  it("opens on the visit asked for, closes onto that visit, and finds it again in a new day", () => {
    const { result, rerender } = renderHook(({ rows }) => useStopDetails(rows), {
      initialProps: { rows: twice },
    });
    const opener = document.createElement("button");
    const find = vi.fn(() => null);
    act(() => result.current.control.open(stop(0), opener, find));
    act(() => result.current.sheet.steps.step(1));
    act(() => result.current.sheet.steps.step(1));
    // The second visit to the first place is another stop: focus goes to its own control.
    act(() => result.current.sheet.onClose());
    expect(find).toHaveBeenCalledWith(stop(2));
    act(() => result.current.control.open(stop(2), opener, find));
    expect(result.current.control.openIndex).toBe(2);
    expect(result.current.sheet.steps.previous).toBe(twice[1]);
    // The day rebuilt without its first stop: the sheet finds its stop by the place.
    const rebuilt = twice.slice(1).map((item, index) => ({ ...item, index }));
    rerender({ rows: rebuilt });
    expect(result.current.control.openIndex).toBe(1);
    expect(result.current.sheet.row).toBe(rebuilt[1]);
  });

  it("finds the Details of the visit asked for on the board, or of the place when it moved", () => {
    const list = document.createElement("ol");
    for (const item of twice) {
      const li = list.appendChild(document.createElement("li"));
      li.dataset.placeId = item.stop.placeId;
      li.appendChild(document.createElement("button")).className = "stop-action--details";
    }
    const buttons = [...list.querySelectorAll<HTMLElement>(".stop-action--details")];
    expect(detailsButtonFor(list, stop(2))).toBe(buttons[2]);
    expect(detailsButtonFor(list, stop(0))).toBe(buttons[0]);
    expect(detailsButtonFor(list, { ...stop(1), index: 3 })).toBe(buttons[1]);
    expect(detailsButtonFor(list, { index: 0, placeId: "place_none" })).toBeNull();
    expect(detailsButtonFor(null, stop(0))).toBeNull();
  });
});

describe("a swipe on the sheet's body", () => {
  const touch = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true };

  function swipe(from: [number, number], ...to: [number, number][]) {
    const area = screen.getByTestId("details-swipe");
    fireEvent.pointerDown(area, { ...touch, clientX: from[0], clientY: from[1] });
    for (const [x, y] of to) fireEvent.pointerMove(area, { ...touch, clientX: x, clientY: y });
    return area;
  }

  function letGo(area: HTMLElement, [x, y]: [number, number]) {
    fireEvent.pointerUp(area, { ...touch, clientX: x, clientY: y });
  }

  it("follows a sideways finger and steps to the next stop when it goes left far enough", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const area = swipe([300, 400], [290, 402], [200, 405]);
    expect(area.dataset.swiping).toBe("true");
    expect(area.style.transform).toBe("translateX(-100px)");
    letGo(area, [200, 405]);
    expect(title()).toBe(row(1).place?.name);
    expect(area.style.transform).toBe("");
    expect(area.dataset.swiping).toBeUndefined();
    // And right to the previous.
    letGo(swipe([100, 400], [112, 400], [220, 400]), [220, 400]);
    expect(title()).toBe(row(0).place?.name);
  });

  it("takes a tap for a tap: no step and nothing moves", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const area = swipe([300, 400], [303, 402]);
    expect(area.style.transform).toBe("");
    letGo(area, [303, 402]);
    expect(title()).toBe(row(0).place?.name);
  });

  it("leaves a finger that sets off downward to the body's scroll", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    // Down first, then across: the first 10 px decided it was a scroll.
    const area = swipe([300, 400], [302, 412], [150, 420]);
    expect(area.style.transform).toBe("");
    letGo(area, [150, 420]);
    expect(title()).toBe(row(0).place?.name);
  });

  it("springs back from a short swipe, a cancelled one, and one past the first stop", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    let area = swipe([300, 400], [312, 400], [318, 400]);
    letGo(area, [318, 400]);
    expect(title()).toBe(row(0).place?.name);
    expect(area.style.transform).toBe("");
    // Past the first stop the body gives only a quarter of the way.
    area = swipe([100, 400], [112, 400], [200, 400]);
    expect(area.style.transform).toBe("translateX(25px)");
    letGo(area, [200, 400]);
    expect(title()).toBe(row(0).place?.name);
    // The browser takes the gesture over.
    area = swipe([300, 400], [288, 400], [200, 400]);
    fireEvent.pointerCancel(area, touch);
    expect(area.style.transform).toBe("");
    expect(area.dataset.swiping).toBeUndefined();
    letGo(area, [200, 400]);
    expect(title()).toBe(row(0).place?.name);
  });

  it("ignores a mouse, a second finger and a stray pointer", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const area = screen.getByTestId("details-swipe");
    const mouse = { ...touch, pointerType: "mouse" };
    fireEvent.pointerDown(area, { ...mouse, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(area, { ...mouse, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(area, { ...mouse, clientX: 100, clientY: 400 });
    fireEvent.pointerDown(area, { ...touch, isPrimary: false, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(area, { ...touch, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(area, { ...touch, clientX: 100, clientY: 400 });
    // Another pointer's moves and release do not count toward this one's swipe.
    swipe([300, 400], [290, 400]);
    const other = { ...touch, pointerId: 8 };
    fireEvent.pointerMove(area, { ...other, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(area, { ...other, clientX: 100, clientY: 400 });
    fireEvent.pointerCancel(area, other);
    expect(title()).toBe(row(0).place?.name);
    expect(area.style.transform).toBe("translateX(-10px)");
  });

  it("lets a second finger make it a pinch, never a step", async () => {
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const area = swipe([300, 400], [288, 400], [220, 400]);
    expect(area.style.transform).toBe("translateX(-80px)");
    // A second finger lands: the body springs back and the first finger no longer steps.
    fireEvent.pointerDown(area, {
      ...touch,
      pointerId: 9,
      isPrimary: false,
      clientX: 120,
      clientY: 500,
    });
    expect(area.style.transform).toBe("");
    expect(area.dataset.swiping).toBeUndefined();
    fireEvent.pointerMove(area, { ...touch, clientX: 100, clientY: 400 });
    expect(area.style.transform).toBe("");
    letGo(area, [100, 400]);
    expect(title()).toBe(row(0).place?.name);
  });

  it("steps without following the finger when the traveler asked for reduced motion", async () => {
    stubMedia({ "(prefers-reduced-motion: reduce)": true });
    const { user } = renderDay();
    await user.click(detailsOf(row(2)));
    const area = swipe([300, 400], [288, 400], [180, 400]);
    expect(area.style.transform).toBe("");
    letGo(area, [180, 400]);
    expect(title()).toBe(row(3).place?.name);
  });

  it("is not a swipe on a day of one stop", async () => {
    const { user } = renderDay({ ...day, rows: [row(0)] });
    await user.click(detailsOf(row(0)));
    const area = swipe([300, 400], [288, 400], [100, 400]);
    expect(area.style.transform).toBe("");
  });
});

describe("the sheet's head on a phone", () => {
  it("does not start a close from a sideways drag", async () => {
    stubMedia({ "(max-width: 767px)": true });
    const { user } = renderDay();
    await user.click(detailsOf(row(0)));
    const head = must(sheet().querySelector<HTMLElement>(".form-sheet-head"), "the sheet's head");
    const grab = { pointerId: 1, button: 0, bubbles: true };
    fireEvent.pointerDown(head, { ...grab, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(head, { ...grab, clientX: 104, clientY: 303 });
    expect(sheet().dataset.dragging).toBeUndefined();
    fireEvent.pointerMove(head, { ...grab, clientX: 160, clientY: 306 });
    fireEvent.pointerMove(head, { ...grab, clientX: 160, clientY: 700 });
    expect(sheet().style.transform).toBe("");
    fireEvent.pointerUp(head, { ...grab, clientX: 160, clientY: 700 });
    expect(sheet().open).toBe(true);
  });
});
