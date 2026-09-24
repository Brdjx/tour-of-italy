import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "../app/error";
import GlobalError from "../app/global-error";
import NotFound from "../app/not-found";

// Pages the traveler sees when something is missing or broken. Next's defaults were an
// unbranded black 404 and "This page couldn't load" with no next step in the app's voice.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("not found", () => {
  it("says the page does not exist and links back to the planner", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This page does not exist.");
    expect(screen.getByTestId("not-found-home").getAttribute("href")).toBe("/");
    expect(screen.getByText("3 Days in Italy")).toBeTruthy();
  });
});

describe("error pages", () => {
  it("offers one clear next step, a reload, and says the last plan is kept", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<ErrorPage />);
    expect(screen.getByTestId("page-message").textContent).toContain(
      "Your last plan is saved on this device",
    );
    await userEvent.setup().click(screen.getByTestId("error-reload"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("brings its own document when the root layout itself fails", () => {
    const html = renderToStaticMarkup(<GlobalError />);
    expect(html.startsWith("<html")).toBe(true);
    expect(html).toContain("This page stopped working.");
  });

  it("uses no curly apostrophes or em dashes in the copy", () => {
    const text = renderToStaticMarkup(
      <>
        <NotFound />
        <ErrorPage />
      </>,
    );
    const banned = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2019)}]`);
    expect(text).not.toMatch(banned);
  });
});
