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

OWN-WORLD: Goodpix paper and ink. White page, warm tile #f6f5f0, ink #11110f as the only fill, gold #a8864b that only draws (the chosen tab, the AI dot, focus), 1px hairlines between board rows, square containers and photos, 999px pills for anything pressed. TikTok Sans with width as rank: display 400 at 150, titles 500 at 125, board times 600 at 87.5 in tabular figures, place names 500 at 112.5. Shadows only on floating sheets. The map is a vector map in the same world: paper land, hairline streets, ink route, gold stops, and a real dark mode.

STORY: The traveler sets a date and a pace and presses Plan my trip. The board flips into Day 1: times, places, areas and travel, with what the data cannot confirm said on the row. A stop opens in place to show its photo, credit and facts. Edits recompute the board, and only the changed times flip. The plan is shared or carried on the phone.

FIRST VIEWPORT: Before a plan: the title in display width, one muted line, start date, the pace pills, More options and the ink pill Plan my trip, above a short strip of real place highlights that sweeps in from top left to bottom right. With a plan: the one-line trip summary with Edit trip, the source line, day tabs with a gold indicator, then the board (time column, place, area, length) with the vector map beside it from 1024 px and below it on phones; switching days moves the map's camera to the new day.

FORM: The departure board (Solari split-flap boards in Italian stations), first on my ordered list and the owner's choice as Impeccable's pick; seed key 5a04eeae. Signature interaction: split-flap arrival, rows flipping into place in a top-left to bottom-right sweep, and only changed times flipping after an edit; reduced motion crossfades.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
