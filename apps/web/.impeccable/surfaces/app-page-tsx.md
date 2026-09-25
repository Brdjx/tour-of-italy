---
version: 1
slug: "app-page-tsx"
primary_target: "app/page.tsx"
related_targets: []
---

# Planner (the one page)

Mode: Operate. A traveler composes a trip, then reads, edits and carries a three-day plan.

Audience and job: a traveler planning at home, the same traveler on a phone in Italy, and hiring reviewers judging craft in minutes. The task is to trust and follow a plan whose times are checked.

Constraints from the owner (2026-09-24): keep the simple flow (date, pace, More options, Plan my trip, then the one-line trip summary); stay strictly factual, never falsify; photos appear as a few highlights and in full when a stop is opened, never as clutter; avoid a booking site, a generic AI app and a slow brochure; Apple-level micro-animation, tasteful custom animated SVG, and an entrance that sweeps from top left to bottom right. Language: the Goodpix main frontend.

## Direction contract

THESIS: Each day is a departure board you check once and trust. It refuses the itinerary-app default of a hero photo over a stack of rounded stop cards with star ratings.

OWN-WORLD: Goodpix paper and ink. White page, warm tile #f6f5f0, ink #11110f as the only fill, gold #a8864b that only draws (the chosen tab, the AI dot, focus), 1px hairlines between board rows, square containers and photos, 999px pills for anything pressed. TikTok Sans with width as rank: display 400 at 150, titles and place names 500 at 125, day tabs 500 at 112.5, board times 600 at 87.5 in tabular figures. Shadows only on floating sheets. The map is a vector map in the same world: paper land, hairline streets, an ink route and ink stops (gold stays off the map), and a real dark mode.

STORY: The traveler sets a date and a pace and presses Plan my trip. The board flips into Day 1: times, places, areas and travel, with what the data cannot confirm said on the row. A stop's photo (an ink hairline and a slight lean on hover) or Details opens it in a sheet over the board, with its photo, credit and facts for the date; Previous and Next walk the day's stops in it, and closing it returns to the row of the stop it shows. Edits recompute the board, and only the changed times flip. The plan is shared or carried on the phone.

FIRST VIEWPORT: Both views open with the flag's band, 4 px across the top of the page under the status bar, drawn in from the left (the Tricolore Rule). Before a plan: the title in display width led by the flag mark at its cap height (its bands drop in, one breath of wind ripples through it with a fold of light and shade, then rest), one muted line, the rail diagram drawn Milan to Rome in gold, start date, the pace pills, More options and the ink pill Plan my trip, above a short strip of real place highlights that sweeps in from top left to bottom right, each tile one button (photo, name with an onward chevron, city; no credit line) that opens the place in a sheet. With a plan, and no navbar: the trip header (the dates as the heading, the pace under them, Edit trip and Copy link beside them and dimmed while a plan is on its way, the source line and Undo under them), day tabs with a gold indicator, then the board (time column, place, area, length) with the vector map beside it from 1024 px and below it on phones; switching days moves the map's camera to the new day.

FORM: The departure board (Solari split-flap boards in Italian stations), first on my ordered list and the owner's choice as Impeccable's pick; seed key 5a04eeae. Signature interaction: split-flap arrival, rows flipping into place in a top-left to bottom-right sweep, and only changed times flipping after an edit; reduced motion crossfades.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Next phase (owner feedback, 2026-09-24)

- No top navbar in the plan view: the space goes to the plan. The trip summary, Edit trip, Copy link and the planned with or without AI line share one compact row.
- Edit trip opens a full-screen overlay over a softly blurred page, with its own entrance and exit motion.
- About this data opens a full-screen overlay with far more detailed data (built 2026-09-25: see below).
- Richer colourways within the design language.
- A detailed per-day skeleton for the itinerary on desktop, tablet and phone.

Edit trip and More options open as sheets over a softly blurred page (the owner's request, 2026-09-25): a phone sheet rises with a grabber while the page recedes; from 768 px a centred panel. Start a new trip in the Edit trip sheet clears the saved plan.

The flag (the owner's request, 2026-09-25): the flag's official colours as a band across the top of both views and a custom animated flag mark leading the first screen's title, and nowhere else (the Tricolore Rule in DESIGN.md); gold stays the accent. Edit trip and Copy link dim and wait while a plan is on its way. A stop's photo and Details open its details in a sheet (a bottom sheet on phones, a centred panel from 768 px) instead of expanding the row.

Place sheets and the data overlay (the owner's request, 2026-09-25: "hide the 'Photo: credit, CCxxxxx' and make it so these are clickable to open a modal / bottom sheet that shows the credits there instead", "a summary of these places (even if generated by AI and saved)", "About this Data ... a full screen overlay / modal with blurred background"): the highlight tiles lose their credit line and each opens a place sheet, the stop details sheet's sibling (a bottom sheet on phones, a centred panel from 768 px): the name and "type in neighbourhood, city", the photo large with its full credit, the AI summary labelled "Summary by AI, from the listing" and leaning, the facts that hold on any date (typical visit, hours by weekday, dates, booking when stated, price, rating), what the data cannot confirm, and the listing's own words. The summaries are written once by Claude from each place's own listing, checked by code and saved; a stop's details sheet shows the same summary in the same place. The footer's About this data opens over a blurred page: a tall bottom sheet on phones, a 760 px panel from 768 px with its own scrolling body, every number computed from the loaded data (places by base and type, each kind of note with its places, hours, how a plan is made, the place summaries, every photo's credit, the map's credits).

The map full screen (the owner's request, 2026-09-25): "Expand map", a round pill in the top right corner of the day's map, opens the same map full screen in a native dialog, grown out of its frame on the smooth spring without stretching it, with the day and its stop count in a paper header, Close map, and the day switcher at its foot (switching there switches the page's day). Escape, the dialog's cancel and Close map shrink it back into its frame, and focus returns to Expand map. Each stop is a button named like its row; hovering or focusing it shows a small square popup (number, place, times, role, "Details") beside it, on the side that stays on the map and hides the fewest other stops and the least of the route, a tap shows it on touch (and a quick second tap opens the details, never a zoom), and the popup, a click or Enter opens the stop's details sheet, the same sheet the board opens, on the page map and full screen alike. Reduced motion fades instead.

Previous and next in a stop's details (the owner's request, 2026-09-25: "arrows to view the next event or the previous event ... so we can navigate the planned stops on that day"): Previous and Next step through the day's stops, meals included, without closing the sheet, with the position ("3 of 6") between them. On phones they are two outline pills of one width in a bar pinned at the foot of the sheet, above the home indicator; from 768px quiet round pills beside Close. They say only the direction, and so do their accessible names ("Next stop"), so a step never renames the focused pill; the live region names the stop. At the first and the last stop the pill dims in place (aria-disabled), never hidden. The bare arrow keys step while focus is in the sheet and not in a control that uses them, and focus stays on the control used, even as the pills move between the foot and the head. A sideways swipe on the body steps on touch; the first 10px decide between a step, the body's scroll and the head's close, and a second finger makes it a pinch to zoom. The new stop's words slide in from the side they came from with the day panels' day-in, while the sheet keeps its height, its controls stay put and the photo's frame stays, the next photo fading in over the last (the Steady Sheet Rule); reduced motion fades. The sheet says each step in its own live region ("Stop 4 of 6, Spanish Steps, 16:30 to 16:50"). The board marks the stop shown as open, and closing gives focus to the stop now shown on what opened the sheet (its Details on the board, brought into view, or its stop on the map), or back to the very opener when the sheet closes on the stop it opened on.
