import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanCallOptions, PlanDayBody } from "../lib/api";
import { ApiError } from "../lib/apiError";
import type { PlanDayResponse } from "../lib/apiSchemas";
import {
  type ItineraryState,
  initialItineraryState,
  itineraryReducer,
} from "../lib/itineraryReducer";
import { useDayRoute } from "../lib/useDayRoute";
import { ctx, dayAnswerFor, fixturePlan } from "./fixtures";

// The route sheet's state on its own: the guards the page cannot reach through its controls, and
// a run the rules cannot finish either, which leaves the trip as it was and says why.

afterEach(cleanup);

type PostDay = (body: PlanDayBody, options: PlanCallOptions) => Promise<PlanDayResponse>;

function planned(overrides = {}): ItineraryState {
  return itineraryReducer(
    initialItineraryState(),
    { type: "plan", itinerary: fixturePlan(overrides), origin: "api" },
    ctx,
  );
}

function hook(plan: ItineraryState, post: PostDay) {
  const announce = vi.fn();
  const apply = vi.fn();
  const showDay = vi.fn();
  const rendered = renderHook(
    (props: { plan: ItineraryState }) =>
      useDayRoute({
        plan: props.plan,
        ctx,
        post,
        announce,
        apply,
        onDayPlanned: vi.fn(),
        showDay,
      }),
    { initialProps: { plan } },
  );
  return { ...rendered, announce, apply, showDay };
}

describe("useDayRoute", () => {
  it("leaves the trip as it was, and says why, when neither the API nor the rules can plan a day", async () => {
    // Every other place in Rome skipped: new ideas for day 1 have nothing to choose from.
    const base = fixturePlan();
    const used = new Set(base.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
    const rest = (ctx.anchorById.get("rome")?.placeIds ?? []).filter((id) => !used.has(id));
    const plan = planned({ exclude: rest });
    const post = vi.fn<PostDay>(async () => {
      throw new ApiError({ kind: "network", message: "offline" });
    });
    const { result, announce, apply } = hook(plan, post);
    act(() => result.current.open(0));
    await act(async () => result.current.ideas());
    expect(post).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith(
      "Nothing in Rome fits day 1 with your settings. Your trip was left as it was.",
      true,
    );
    expect(result.current.pending).toBeNull();
  });

  it("does nothing for a route with no change, and opens no sheet while days are planned", async () => {
    const plan = planned();
    let answer: () => void = () => {};
    const post = vi.fn<PostDay>(
      (body) =>
        new Promise((resolve) => {
          answer = () => resolve(dayAnswerFor(body));
        }),
    );
    const { result, apply } = hook(plan, post);
    act(() => result.current.open(1));
    act(() => result.current.confirm());
    expect(post).not.toHaveBeenCalled();
    expect(result.current.sheet.open).toBe(true);
    act(() => result.current.choose("florence"));
    expect(result.current.sheet).toMatchObject({
      level: "route",
      draft: ["rome", "florence", "rome"],
    });
    act(() => result.current.confirm());
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.current.sheet.open).toBe(false);
    // A second route cannot start, and the sheet stays shut, while this one plans.
    act(() => result.current.open(2));
    expect(result.current.sheet.open).toBe(false);
    act(() => result.current.ideas());
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => answer());
    await act(async () => answer());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({ type: "replan", kind: "city" });
  });

  it("stops a run when the plan goes away", async () => {
    const plan = planned();
    const post = vi.fn<PostDay>(() => new Promise(() => {}));
    const { result, rerender, apply } = hook(plan, post);
    act(() => result.current.open(2));
    act(() => result.current.choose("venice"));
    act(() => result.current.confirm());
    expect(result.current.pending).not.toBeNull();
    rerender({ plan: itineraryReducer(plan, { type: "clear" }, ctx) });
    expect(result.current.pending).toBeNull();
    expect(post.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    // With no plan, nothing opens and nothing plans.
    act(() => result.current.open(0));
    expect(result.current.sheet.open).toBe(false);
    act(() => result.current.reset());
    act(() => result.current.ideas());
    act(() => result.current.confirm());
    expect(post).toHaveBeenCalledTimes(1);
  });
});
