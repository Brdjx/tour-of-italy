import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutDataSheet } from "../components/AboutDataSheet";
import { DataNotesPanel } from "../components/DataNotesPanel";
import type { Health } from "../lib/apiSchemas";
import { photoCredits } from "../lib/placePhotos";
import file from "../lib/placeSummaries.data.json";
import { CLAIM_STARTS } from "../lib/sourceText";
import { ctx, dataset, must, places } from "./fixtures";

// "About this data" opens over the page instead of unfolding under the footer. Every number in it
// comes from the loaded data: the places by base and type, each kind of note with its places, the
// hours, the saved place summaries, every photo's credit. The planner's model is named only when
// the health check names a Claude model. Focus goes to the title on open and back to the link on
// close.

afterEach(cleanup);

const summary = dataset.summary;
const sheet = () => screen.getByTestId("about-sheet") as HTMLDialogElement;
const health = (model: string | null, llmAvailable = true): Health => ({
  ok: true,
  version: "1.0.0",
  commit: "dev",
  llmAvailable,
  model,
});

function renderPanel() {
  const user = userEvent.setup();
  render(<DataNotesPanel data={{ places, ctx, summary }} />);
  return user;
}

function renderSheet(loadHealth: (signal: AbortSignal) => Promise<Health>) {
  return render(
    <AboutDataSheet
      id="about"
      open
      onClose={() => {}}
      returnFocus={{ current: null }}
      places={places}
      ctx={ctx}
      summary={summary}
      loadHealth={loadHealth}
    />,
  );
}

/** The number at the end of each count row, by its term. */
function counts(list: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of list.querySelectorAll(".about-count")) {
    out[row.querySelector("dt")?.textContent ?? ""] = Number(row.querySelector("dd")?.textContent);
  }
  return out;
}

describe("the About this data link", () => {
  it("is a button with no count that opens the overlay and puts focus on its title", async () => {
    const user = renderPanel();
    const link = screen.getByTestId("data-notes-link");
    expect(link.tagName).toBe("BUTTON");
    expect(link.textContent).toBe("About this data");
    expect(link.getAttribute("aria-haspopup")).toBe("dialog");
    expect(sheet().open).toBe(false);
    await user.click(link);
    expect(sheet().open).toBe(true);
    expect(link.getAttribute("aria-expanded")).toBe("true");
    expect(link.getAttribute("aria-controls")).toBe(sheet().id);
    const title = screen.getByTestId("about-title");
    expect(title.textContent).toBe("About this data");
    expect(sheet().getAttribute("aria-labelledby")).toBe(title.id);
    expect(document.activeElement).toBe(title);
  });

  it("closes with Escape and with its close pill, giving focus back to the link", async () => {
    const user = renderPanel();
    const link = screen.getByTestId("data-notes-link");
    await user.click(link);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute("aria-expanded")).toBe("false");
    await user.click(link);
    await user.click(screen.getByRole("button", { name: "Close About this data" }));
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(link);
  });
});

describe("the About this data overlay", () => {
  it("leads with how the data stands, then has every section", () => {
    renderSheet(async () => health(null, false));
    expect(screen.getByTestId("data-headline").textContent).toBe(summary.headline);
    expect(summary.headline).toBe("103 places loaded, all usable for planning.");
    const headings = within(sheet())
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "The places",
      "What was cleaned or flagged, and why",
      "Opening hours and notes",
      "How a plan is made",
      "Place summaries",
      "Photo credits",
      "The map",
    ]);
    for (const id of ["places", "issues", "hours", "plan", "summaries", "credits", "map"]) {
      expect(screen.getByTestId(`about-${id}`).getAttribute("aria-labelledby")).toBeTruthy();
    }
  });

  it("counts the places by base, with each base's day trips, and the counts add up", () => {
    renderSheet(async () => health(null, false));
    const rows = [...screen.getByTestId("about-bases").querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual(
      ctx.anchors.map((anchor) => anchor.name),
    );
    const totals = rows.map((row) => Number(row.querySelector("td:last-child")?.textContent));
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(places.length);
    const rome = must(rows[0]);
    expect(rome.textContent).toBe(`Rome${places.filter((p) => p.city === "Rome").length}None30`);
    const bologna = must(rows.find((row) => row.querySelector("th")?.textContent === "Bologna"));
    expect(bologna.textContent).toContain("Modena 3, Parma 2");
  });

  it("counts the places by type and by where their hours come from", () => {
    renderSheet(async () => health(null, false));
    const types = counts(screen.getByTestId("about-types"));
    expect(Object.values(types).reduce((sum, value) => sum + value, 0)).toBe(places.length);
    expect(types["Historic site"]).toBe(places.filter((p) => p.type === "historic_site").length);
    const hours = counts(screen.getByTestId("about-hours"));
    expect(hours).toEqual({
      "Listed in the data": places.filter((p) => p.hoursConfidence === "listed").length,
      "Estimated from the listing": places.filter((p) => p.hoursConfidence === "derived").length,
      "Public spaces, no set hours": places.filter((p) => p.hoursConfidence === "open_access")
        .length,
      "Not in the data": places.filter((p) => p.hoursConfidence === "unknown").length,
    });
    expect(screen.getByTestId("about-hours").textContent).toContain("planned from 07:00 to 23:00");
  });

  it("lists every kind of note with its count, explanation and places, folding long lists", () => {
    renderSheet(async () => health(null, false));
    const section = screen.getByTestId("about-issues");
    expect(section.textContent).toContain(
      `logged ${summary.totals.issues} notes of ${summary.items.length} kinds`,
    );
    const groups = within(section).getAllByTestId("about-issue");
    expect(groups).toHaveLength(summary.items.length);
    summary.items.forEach((item, index) => {
      const group = must(groups[index]);
      expect(group.querySelector(".about-group-title")?.textContent).toBe(item.title);
      expect(group.querySelector(".about-group-count")?.textContent).toBe(
        `${item.count} ${item.count === 1 ? "place" : "places"}`,
      );
      expect(group.textContent).toContain(item.explanation);
      const folded = group.querySelector("details");
      expect(folded !== null).toBe(item.places.length > 8);
      // Every place's name is in the group, folded or not.
      for (const place of item.places) expect(group.textContent).toContain(place.name);
    });
  });

  it("credits every photo the site uses, with its licence and source linked", () => {
    renderSheet(async () => health(null, false));
    const list = screen.getByTestId("about-credit-list");
    const items = [...list.querySelectorAll("li")];
    expect(items).toHaveLength(photoCredits().length);
    const colosseum = must(items.find((item) => item.textContent?.startsWith("Colosseum")));
    const links = [...colosseum.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links[0]).toMatch(/^https:\/\/creativecommons\.org\//);
    expect(links[1]).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    // The source link is the work's title, as the CC 2.0 and 3.0 licences ask.
    const credit = must(photoCredits().find((row) => row.key === "place_001"));
    const source = must(colosseum.querySelector(".about-credit-source"));
    expect(source.textContent).toBe(`${credit.title} on Wikimedia Commons`);
    expect(source.querySelector("a")?.textContent).toBe(credit.title);
    expect(screen.getByTestId("about-credits").textContent).toContain(
      `${photoCredits().length} photos, all from Wikimedia Commons`,
    );
    const map = screen.getByTestId("about-map");
    expect([...map.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "OpenStreetMap contributors",
      "Protomaps",
    ]);
  });

  it("names the planner's model when the health check names a Claude model", async () => {
    const load = vi.fn(async () => health("claude-sonnet-5"));
    renderSheet(load);
    await waitFor(() =>
      expect(screen.getByTestId("about-plan-text").textContent).toContain(
        "The AI planner (Claude, model claude-sonnet-5) chooses a base",
      ),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the scripted local client", async () => health("fixture")],
    ["a planner that is off", async () => health(null, false)],
    ["a failed health check", async () => Promise.reject(new Error("offline"))],
  ])("names no model for %s", async (_case, load) => {
    const loader = vi.fn(load);
    renderSheet(loader);
    await waitFor(() => expect(loader).toHaveBeenCalled());
    expect(screen.getByTestId("about-plan-text").textContent).toMatch(
      /^The AI planner chooses a base/,
    );
  });

  it("says the AI also writes each stop's reason and the trip summary, and code checks them", () => {
    renderSheet(async () => health(null, false));
    const text = screen.getByTestId("about-plan-text").textContent;
    expect(text).toContain("writes each stop's one-line reason and the trip summary");
    expect(text).toContain(
      "a reason that does not hold for its stop is replaced by one code writes",
    );
  });

  it("says what the source line under the trip's dates means, which the line itself does not", () => {
    renderSheet(async () => health(null, false));
    const line = screen.getByTestId("about-plan-line").textContent ?? "";
    expect(line).toContain("The line under the trip's dates says how the plan on screen was made.");
    expect(line).toContain("gold when the AI planner chose the places and wrote the reasons");
    const marks = screen.getByTestId("about-plan-marks").textContent ?? "";
    expect(marks).toContain('After a change the line adds "edited".');
    expect(marks).toContain("Every edit is checked again");
    expect(marks).toContain("a filled gold dot marks a reason the AI wrote");
    const day = screen.getByTestId("about-plan-day").textContent ?? "";
    expect(day).toContain("Only that day is planned again");
    expect(day).toContain('"Planned again with AI"');
    expect(day).toContain("such a day shows the rules' reasons there");
  });

  it("explains each claim of the source line in a row keyed by the words the line starts with", () => {
    renderSheet(async () => health(null, false));
    const rows = screen.getAllByTestId("about-plan-claim");
    const term = (row: HTMLElement) => row.querySelector("dt")?.textContent;
    const meaning = (row: HTMLElement) => row.querySelector("dd")?.textContent ?? "";
    expect(rows.map(term)).toEqual(Object.values(CLAIM_STARTS));
    const by = (claim: string) => meaning(must(rows.find((row) => term(row) === claim)));
    expect(by("Planned with AI, fixed after a check")).toBe(
      "The AI's first draft broke a rule, so code dropped or reordered stops, or asked the AI to fix it.",
    );
    expect(by("Planned without AI")).toContain("The words after the colon say why");
    expect(by("Planned on this device")).toContain("so it made one by rules");
    expect(by("Shared plan, rebuilt from its places")).toContain(
      "A shared link carries only the trip's settings and places",
    );
    expect(by("Saved trip")).toContain(
      "A saved link keeps the times and reasons the trip was saved with",
    );
  });

  it("says how many places have an AI summary, which model wrote them and when, from the file", () => {
    renderSheet(async () => health(null, false));
    const text = screen.getByTestId("about-summaries-text").textContent;
    const models = [...new Set(file.summaries.map((row) => row.model))];
    expect(models).toEqual(["claude-opus-5-5"]);
    expect(text).toContain(
      `${file.summaries.length} of the ${places.length} places have a one or two sentence summary, labelled "Summary by AI, from the listing" in their sheet.`,
    );
    expect(text).toContain("Claude (model claude-opus-5-5) wrote each one on ");
    expect(text).toContain("from that place's own listing alone, and code checked it");
  });

  it("counts only the loaded places' summaries", () => {
    const some = places.slice(0, 3);
    render(
      <AboutDataSheet
        id="about"
        open
        onClose={() => {}}
        returnFocus={{ current: null }}
        places={[...some, { ...must(places[3]), id: "place_without_summary" }]}
        ctx={ctx}
        summary={summary}
        loadHealth={async () => health(null, false)}
      />,
    );
    expect(screen.getByTestId("about-summaries-text").textContent).toContain(
      '3 of the 4 places have a one or two sentence summary, labelled "Summary by AI, from the listing" in their sheet; the other 1 has none.',
    );
  });

  it("leaves the summaries out when no loaded place has one", () => {
    render(
      <AboutDataSheet
        id="about"
        open
        onClose={() => {}}
        returnFocus={{ current: null }}
        places={[{ ...must(places[0]), id: "place_without_summary" }]}
        ctx={ctx}
        summary={summary}
        loadHealth={async () => health(null, false)}
      />,
    );
    expect(screen.queryByTestId("about-summaries")).toBeNull();
  });

  it("asks for the model only once the overlay opens", async () => {
    const load = vi.fn(async () => health("claude-sonnet-5"));
    const props = {
      id: "about",
      onClose: () => {},
      returnFocus: { current: null },
      places,
      ctx,
      summary,
      loadHealth: load,
    };
    const { rerender } = render(<AboutDataSheet {...props} open={false} />);
    expect(load).not.toHaveBeenCalled();
    rerender(<AboutDataSheet {...props} open />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender(<AboutDataSheet {...props} open={false} />);
    rerender(<AboutDataSheet {...props} open />);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
