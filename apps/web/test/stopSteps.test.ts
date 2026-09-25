import { describe, expect, it } from "vitest";
import {
  AXIS_SLOP,
  gestureAxis,
  keyStep,
  SWIPE_DISTANCE,
  SWIPE_FLICK_MIN,
  SWIPE_FLICK_SPEED,
  SWIPE_RESIST,
  stepAnnouncement,
  swipeOffset,
  swipeStep,
  takesArrows,
} from "../lib/stopSteps";
import { buildDayView, type RowView } from "../lib/timetable";
import { ctx, fixturePlan, must } from "./fixtures";

// The rules behind stepping through a day's stops in the details sheet: which way a finger is
// going, when a swipe steps, which keys step, and what the sheet says when it does.

const plan = fixturePlan();
const day = must(buildDayView(plan, 0, ctx, []));
const last = must(buildDayView(plan, 2, ctx, []));

describe("which way a gesture goes", () => {
  it("waits for the first 10 px before deciding", () => {
    expect(AXIS_SLOP).toBe(10);
    expect(gestureAxis(0, 0)).toBeNull();
    expect(gestureAxis(6, 7)).toBeNull(); // 9.2 px along the diagonal
    expect(gestureAxis(-9.9, 0)).toBeNull();
  });

  it("goes across when it moved more across than down, and down otherwise", () => {
    expect(gestureAxis(10, 0)).toBe("x");
    expect(gestureAxis(-12, 5)).toBe("x");
    expect(gestureAxis(3, 10)).toBe("y");
    expect(gestureAxis(0, -10)).toBe("y");
    // Exactly diagonal is a scroll or a close, never a step the traveler did not mean.
    expect(gestureAxis(8, 8)).toBe("y");
    expect(gestureAxis(-8, -8)).toBe("y");
  });

  it("takes its own threshold", () => {
    expect(gestureAxis(12, 0, 20)).toBeNull();
    expect(gestureAxis(20, 0, 20)).toBe("x");
  });
});

describe("a swipe let go", () => {
  it("steps to the next stop when it went left far enough, and to the previous going right", () => {
    expect(swipeStep(-SWIPE_DISTANCE, 0)).toBe(1);
    expect(swipeStep(-200, -0.1)).toBe(1);
    expect(swipeStep(SWIPE_DISTANCE, 0)).toBe(-1);
    expect(swipeStep(140, 0.05)).toBe(-1);
  });

  it("stays when it was short and slow", () => {
    expect(swipeStep(-(SWIPE_DISTANCE - 1), 0)).toBe(0);
    expect(swipeStep(40, 0.1)).toBe(0);
    expect(swipeStep(0, 0)).toBe(0);
  });

  it("steps on a short flick, but not on one too short to be meant", () => {
    expect(swipeStep(-SWIPE_FLICK_MIN, -SWIPE_FLICK_SPEED)).toBe(1);
    expect(swipeStep(30, 0.6)).toBe(-1);
    expect(swipeStep(-(SWIPE_FLICK_MIN - 1), -1)).toBe(0);
  });

  it("stays when the finger flicked back against the swipe", () => {
    expect(swipeStep(-120, 0.5)).toBe(0);
    expect(swipeStep(90, -SWIPE_FLICK_SPEED)).toBe(0);
    expect(swipeStep(-30, 0.8)).toBe(0);
  });
});

describe("how far the content follows the finger", () => {
  it("all the way toward a stop there is", () => {
    const both = { previous: true, next: true };
    expect(swipeOffset(-80, both)).toBe(-80);
    expect(swipeOffset(80, both)).toBe(80);
  });

  it("a quarter of the way past the first or the last stop", () => {
    expect(swipeOffset(80, { previous: false, next: true })).toBe(80 * SWIPE_RESIST);
    expect(swipeOffset(-80, { previous: true, next: false })).toBe(-80 * SWIPE_RESIST);
    expect(swipeOffset(-80, { previous: false, next: true })).toBe(-80);
  });
});

describe("the keys that step", () => {
  const bare = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  it("are the bare left and right arrows", () => {
    expect(keyStep({ ...bare, key: "ArrowRight" })).toBe(1);
    expect(keyStep({ ...bare, key: "ArrowLeft" })).toBe(-1);
    expect(keyStep({ ...bare, key: "ArrowDown" })).toBeNull();
    expect(keyStep({ ...bare, key: "Enter" })).toBeNull();
  });

  it("leave an arrow with a modifier to the browser (Alt+Left is Back)", () => {
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(keyStep({ ...bare, [modifier]: true, key: "ArrowLeft" })).toBeNull();
    }
  });

  it("belong to a field, a slider, editable text or a widget that moves with them instead", () => {
    const input = (type: string) => Object.assign(document.createElement("input"), { type });
    expect(takesArrows(input("text"))).toBe(true);
    expect(takesArrows(input("search"))).toBe(true);
    expect(takesArrows(input("date"))).toBe(true);
    expect(takesArrows(document.createElement("textarea"))).toBe(true);
    expect(takesArrows(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not compute isContentEditable; a browser does.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(takesArrows(editable)).toBe(true);
    // A slider and a radio move their value with them.
    expect(takesArrows(input("range"))).toBe(true);
    expect(takesArrows(input("radio"))).toBe(true);
    // So does a widget built on the arrows, from any element inside it.
    for (const role of ["slider", "radiogroup", "tablist", "listbox", "grid", "menu", "combobox"]) {
      const widget = document.createElement("div");
      widget.setAttribute("role", role);
      const inside = widget.appendChild(document.createElement("button"));
      expect(takesArrows(widget)).toBe(true);
      expect(takesArrows(inside)).toBe(true);
    }
    const spin = document.createElement("span");
    spin.setAttribute("role", "spinbutton");
    expect(takesArrows(spin)).toBe(true);
    // Buttons, boxes and headings leave them to the sheet.
    expect(takesArrows(input("checkbox"))).toBe(false);
    expect(takesArrows(document.createElement("button"))).toBe(false);
    expect(takesArrows(document.createElement("h2"))).toBe(false);
    expect(takesArrows(null)).toBe(false);
    expect(takesArrows(window)).toBe(false);
  });
});

describe("what the sheet says when it steps", () => {
  it("names the stop, its place in the day and its times", () => {
    const steps = must(last.rows.find((row) => row.place?.name === "Spanish Steps"));
    expect(stepAnnouncement(steps, last.rows.length)).toBe(
      "Stop 6 of 7, Spanish Steps, 18:20 to 18:40",
    );
  });

  it("says which meal a meal is, as the map's stops do", () => {
    const lunch = must(day.rows.find((row) => row.stop.role === "lunch"));
    expect(stepAnnouncement(lunch, 6)).toBe(
      "Stop 2 of 6, Roscioli Salumeria, 13:05 to 14:35, lunch",
    );
  });

  it("names a place no longer in the data plainly", () => {
    const row: RowView = { ...must(day.rows[0]), place: undefined };
    expect(stepAnnouncement(row, 6)).toMatch(/^Stop 1 of 6, A place no longer in the data, /);
  });
});
