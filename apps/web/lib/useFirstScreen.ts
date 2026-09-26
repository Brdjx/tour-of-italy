import { type RefObject, useLayoutEffect } from "react";

// The first screen on phones and tablets in portrait ends with Plan my trip; the highlights and
// About this data wait below the fold (layout.css, the owner's call on 2026-09-25). The header and
// the form sit in different parents, so CSS cannot size them together: this measures where the
// form starts, from the top of the document, and hands it to CSS as --form-top. It measures again
// when the header changes size (the title wraps, the rail diagram shows or hides) or the window
// does.

/** Sets --form-top on `app` to the top of the element with id `formId`, while `active`. */
export function useFirstScreen(
  app: RefObject<HTMLElement | null>,
  formId: string,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const root = app.current;
    const form = document.getElementById(formId);
    if (!active || !root || !form) return;
    const measure = () => {
      const top = form.getBoundingClientRect().top + window.scrollY;
      root.style.setProperty("--form-top", `${Math.round(top)}px`);
    };
    measure();
    const header = root.querySelector(".app-header");
    const observer =
      typeof ResizeObserver === "function" && header ? new ResizeObserver(measure) : null;
    if (observer && header) observer.observe(header);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--form-top");
    };
  }, [app, formId, active]);
}
