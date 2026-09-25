import { LAST_PLAN_KEY } from "./lastPlan";
import { TRIP_PARAM } from "./savedTrip";
import { SHARE_PARAM } from "./shareLink";

// A few lines that run in <head>, before the first paint of the static HTML. The HTML is the same
// for every visit and shows the empty form; a traveler who opens a shared or saved-trip link or
// comes back to a saved plan should not see that form paint and then jump into the plan layout
// (a large layout shift). When a plan is expected, this marks <html> with data-expect-plan, and
// CSS paints the compact header over an empty page until the app takes over
// (lib/usePlanExpected.ts removes the mark in the same frame it shows the plan's skeleton).

export const EXPECT_PLAN_ATTR = "data-expect-plan";

/** The script's source. Built from the same constants the app reads, so the two cannot drift. */
export function expectPlanScript(): string {
  const param = JSON.stringify(SHARE_PARAM);
  const trip = JSON.stringify(TRIP_PARAM);
  const key = JSON.stringify(LAST_PLAN_KEY);
  const attr = JSON.stringify(EXPECT_PLAN_ATTR);
  // Decision: plain ES5 in a try block. It runs before any bundle, so it must not throw in an old
  // browser or when storage is blocked; the worst case is the old behaviour, never a broken page.
  return [
    "try{",
    `var q=new URLSearchParams(location.search),s=q.get(${param}),t=q.get(${trip});`,
    `var k=null;try{k=localStorage.getItem(${key})}catch(e){}`,
    `if(s!==null||t!==null||k!==null)document.documentElement.setAttribute(${attr},"")`,
    "}catch(e){}",
  ].join("");
}
