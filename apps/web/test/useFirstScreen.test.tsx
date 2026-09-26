import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFirstScreen } from "../lib/useFirstScreen";

// The first screen ends with Plan my trip on phones: the page hands CSS where the form starts.

afterEach(cleanup);

function Page({ active }: { active: boolean }) {
  const app = useRef<HTMLDivElement>(null);
  useFirstScreen(app, "form", active);
  return (
    <div ref={app} data-testid="app">
      <header className="app-header">Title</header>
      <section id="form">Form</section>
    </div>
  );
}

describe("useFirstScreen", () => {
  it("sets --form-top to where the form starts, and clears it when the view changes", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 412.4 } as DOMRect);
    try {
      const view = render(<Page active />);
      const app = view.getByTestId("app");
      expect(app.style.getPropertyValue("--form-top")).toBe("412px");
      view.rerender(<Page active={false} />);
      expect(app.style.getPropertyValue("--form-top")).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("measures again when the window changes size", () => {
    let top = 300;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ top }) as DOMRect);
    try {
      const view = render(<Page active />);
      top = 350;
      window.dispatchEvent(new Event("resize"));
      expect(view.getByTestId("app").style.getPropertyValue("--form-top")).toBe("350px");
    } finally {
      spy.mockRestore();
    }
  });
});
