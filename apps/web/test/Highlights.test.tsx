import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Highlights } from "../components/Highlights";
import { PlaceSheet } from "../components/PlaceSheet";
import { HIGHLIGHT_PLACE_IDS, photoForPlace } from "../lib/placePhotos";
import { summaryForPlace } from "../lib/placeSummaries";
import { ctx, must, place } from "./fixtures";

// The highlights on the first screen: each tile is one button, with no credit line under it, that
// opens the place in a sheet: its name and where it is, the photo large with its full credit, the
// AI summary under its own label, the facts that hold on any date, what the data cannot confirm
// and the listing's own words. Escape or the close pill shuts it and gives focus back to the tile.

afterEach(cleanup);

const sheet = () => screen.getByTestId("place-sheet") as HTMLDialogElement;
const tiles = () => screen.getAllByTestId("highlight-button");
const colosseum = place("place_001");

function renderHighlights() {
  const user = userEvent.setup();
  render(<Highlights ctx={ctx} />);
  return user;
}

describe("the highlight tiles", () => {
  it("are one button each, named for the place and what the button opens, with no credit line", () => {
    renderHighlights();
    expect(tiles()).toHaveLength(HIGHLIGHT_PLACE_IDS.length);
    const first = must(tiles()[0]);
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("aria-label")).toBe("Colosseum, Rome: photo, details and credit");
    expect(first.getAttribute("aria-haspopup")).toBe("dialog");
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(first.getAttribute("aria-controls")).toBe(sheet().id);
    // The photo, the name and the city are inside the one button; nothing else is pressable.
    expect(first.querySelector("img")?.getAttribute("alt")).toBe(photoForPlace(colosseum)?.alt);
    expect(first.textContent).toBe("ColosseumRome");
    const grid = screen.getByTestId("highlights");
    expect(grid.querySelector(".photo-credit")).toBeNull();
    expect(within(grid).queryAllByRole("link")).toHaveLength(0);
  });

  it("hold square skeletons, and no buttons, until the places load", () => {
    render(<Highlights ctx={null} />);
    expect(screen.queryAllByTestId("highlight-button")).toHaveLength(0);
    expect(screen.getByTestId("highlights").querySelector("ul")?.getAttribute("aria-busy")).toBe(
      "true",
    );
  });
});

describe("the place sheet", () => {
  it("opens from a tile, titled with the place, its type and where it is, and takes focus", async () => {
    const user = renderHighlights();
    expect(sheet().open).toBe(false);
    const tile = must(tiles()[0]);
    await user.click(tile);
    expect(sheet().open).toBe(true);
    expect(tile.getAttribute("aria-expanded")).toBe("true");
    const title = screen.getByTestId("place-title");
    expect(title.textContent).toBe("Colosseum");
    expect(sheet().getAttribute("aria-labelledby")).toBe(title.id);
    expect(document.activeElement).toBe(title);
    expect(title.parentElement?.querySelector(".stop-subtitle")?.textContent).toBe(
      "Historic site in Celio, Rome",
    );
  });

  it("shows the photo large with its full credit: author, licence and source, each linked", async () => {
    const user = renderHighlights();
    await user.click(must(tiles()[0]));
    const photo = must(photoForPlace(colosseum));
    const img = must(sheet().querySelector(".place-photo--wide img"), "the large photo");
    expect(img.getAttribute("alt")).toBe(photo.alt);
    const credit = must(sheet().querySelector(".photo-credit"), "the credit");
    expect(credit.textContent).toBe(`Photo: ${photo.author}, ${photo.license}, Wikimedia Commons`);
    const links = [...credit.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual([photo.licenseUrl, photo.sourceUrl]);
  });

  it("shows the AI summary under its own label, then the facts, the caveats and the listing", async () => {
    const user = renderHighlights();
    await user.click(must(tiles()[0]));
    const summary = within(sheet()).getByTestId("place-summary");
    expect(summary.querySelector("figcaption")?.textContent).toBe(
      "Summary by AI, from the listing",
    );
    expect(summary.querySelector("p")?.textContent).toBe(summaryForPlace("place_001"));
    const facts = within(sheet()).getByTestId("place-fact-sheet");
    const terms = [...facts.querySelectorAll("dt")].map((term) => term.textContent);
    expect(terms).toEqual(["Typical visit", "Hours", "Booking", "Price", "Rating"]);
    expect(facts.querySelector('[data-fact="visit"] dd')?.textContent).toBe("2 h");
    expect(facts.querySelector('[data-fact="hours"] li')?.textContent).toBe(
      "Every day09:00 to 19:00",
    );
    expect(facts.querySelector('[data-fact="rating"] dd')?.textContent).toBe(
      "4.8 of 5 in the data",
    );
    const caveats = screen.getByRole("list", { name: "What the data cannot confirm" });
    expect(within(caveats).getAllByTestId("stop-caveat")[0]?.textContent).toContain(
      "A seasonal note in the listing:",
    );
    expect(
      within(sheet()).getByTestId("stop-description").querySelector("blockquote")?.textContent,
    ).toBe(colosseum.description.trim());
    // The parts come in the reading order: photo, summary, facts, caveats, listing.
    const parts = [...must(within(sheet()).getByTestId("place-details")).children].map(
      (part) => part.className,
    );
    expect(parts).toEqual([
      "place-details-photo",
      "place-summary",
      "fact-board",
      "stop-unconfirmed",
      "stop-listing",
    ]);
  });

  it("opens from the keyboard and closes with Escape, giving focus back to the tile", async () => {
    const user = renderHighlights();
    const tile = must(tiles()[2]);
    tile.focus();
    await user.keyboard("{Enter}");
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("place-title").textContent).toBe(place("place_066").name);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("false");
    // The place stays in the sheet while it leaves, so it never empties on its way out.
    expect(screen.getByTestId("place-title").textContent).toBe(place("place_066").name);

    await user.keyboard(" ");
    expect(sheet().open).toBe(true);
  });

  it("closes from its close pill and opens again on another tile", async () => {
    const user = renderHighlights();
    const [first, second] = tiles();
    await user.click(must(first));
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(first);
    await user.click(must(second));
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("place-title").textContent).toBe(place("place_084").name);
    expect(must(second).getAttribute("aria-expanded")).toBe("true");
    expect(must(first).getAttribute("aria-expanded")).toBe("false");
  });

  it("gives a place with no neighbourhood, set hours or booking what the data has", () => {
    const trevi = { ...place("place_018"), neighborhood: null, bookingRequired: null };
    render(
      <PlaceSheet id="p" open place={trevi} onClose={() => {}} returnFocus={{ current: null }} />,
    );
    const subtitle = sheet().querySelector(".stop-subtitle");
    expect(subtitle?.textContent).toBe("Historic site in Rome");
    const facts = screen.getByTestId("place-fact-sheet");
    expect(facts.querySelector('[data-fact="hours"] dd')?.textContent).toBe("No set hours");
    expect(facts.querySelector('[data-fact="booking"]')).toBeNull();
  });

  it("is empty and untitled before any place is shown", () => {
    render(
      <PlaceSheet
        id="p"
        open={false}
        place={null}
        onClose={() => {}}
        returnFocus={{ current: null }}
      />,
    );
    expect(screen.getByTestId("place-title").textContent).toBe("");
    expect(screen.queryByTestId("place-details")).toBeNull();
  });
});
