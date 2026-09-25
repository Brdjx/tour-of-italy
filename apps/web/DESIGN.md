---
name: 3 Days in Italy
description: A three-day plan read as a departure board, in paper and ink.
colors:
  page: "#ffffff"
  surface: "#ffffff"
  surface-warm: "#f6f5f0"
  tile: "#f4f4f1"
  ink: "#11110f"
  muted: "#6a6a63"
  line: "#dcdad3"
  line-strong: "#85837a"
  fill: "#11110f"
  fill-fg: "#ffffff"
  fill-hover: "#2a2a26"
  hover: "#f3f3f0"
  accent: "#7d5f2c"
  accent-soft: "#f6f0e1"
  gold: "#a8864b"
  gold-soft: "#d8bd82"
  warn: "#f3d27a"
  danger: "#b3261e"
  danger-soft: "#fbeceb"
  focus: "#7d5f2c"
  flag-green: "#008c45"
  flag-white: "#f4f5f0"
  flag-red: "#cd212a"
typography:
  display:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(2.125rem, 7vw, 3rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.01em"
    fontVariation: "\"wdth\" 150"
  headline:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(1.625rem, 4vw, 2.25rem)"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-0.01em"
    fontVariation: "\"wdth\" 125"
  title:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "\"wdth\" 125"
  tab:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    letterSpacing: "-0.01em"
    fontVariation: "\"wdth\" 112.5"
  time:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "0"
    fontFeature: "\"tnum\" 1"
    fontVariation: "\"wdth\" 87.5"
  body:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.35
  label:
    fontFamily: "TikTok Sans, TikTok Sans Fallback, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    letterSpacing: "0.02em"
    fontVariation: "\"wdth\" 87.5"
rounded:
  square: "0"
  sheet: "20px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "14px"
  lg: "28px"
  gutter-phone: "16px"
  gutter-tablet: "24px"
  gutter-desktop: "32px"
  column-compose: "560px"
  column-plan: "1120px"
components:
  button-primary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.fill-fg}"
    rounded: "{rounded.pill}"
    height: "52px"
  button-primary-hover:
    backgroundColor: "{colors.fill-hover}"
  pill-fill:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.fill-fg}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "44px"
  pill-line:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px 0 14px"
    height: "44px"
  pill-line-hover:
    backgroundColor: "{colors.hover}"
  pill-quiet:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "44px"
  pill-quiet-hover:
    backgroundColor: "{colors.hover}"
  segmented-thumb:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.fill-fg}"
    rounded: "{rounded.pill}"
    height: "44px"
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "0 14px"
    height: "48px"
  choice-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "0 14px"
    height: "44px"
  choice-chip-checked:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.fill-fg}"
  chip-warning:
    backgroundColor: "{colors.warn}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "0 9px"
    height: "26px"
  chip-note:
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "0 9px"
    height: "26px"
  chip-error:
    textColor: "{colors.danger}"
    rounded: "{rounded.square}"
    padding: "0 9px"
    height: "26px"
  count-badge:
    backgroundColor: "{colors.gold-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "24px"
  day-tab:
    textColor: "{colors.muted}"
    typography: "{typography.tab}"
    height: "60px"
  day-tab-active:
    textColor: "{colors.ink}"
  board-time:
    textColor: "{colors.ink}"
    typography: "{typography.time}"
    width: "64px"
  stop-name:
    textColor: "{colors.ink}"
    typography: "{typography.title}"
  head-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px 0 14px"
    height: "44px"
  head-pill-hover:
    backgroundColor: "{colors.hover}"
  sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    width: "560px"
  sheet-grabber:
    backgroundColor: "{colors.line-strong}"
    rounded: "{rounded.pill}"
    width: "36px"
    height: "5px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.fill-fg}"
    rounded: "{rounded.square}"
    padding: "4px 4px 4px 16px"
  tricolore-band:
    height: "4px"
  flag-mark:
    height: "1cap"
    rounded: "{rounded.square}"
---

# Design System: 3 Days in Italy

## Overview

**Creative North Star: "The Departure Board"**

Each day is a board you check once and trust, drawn in the Goodpix language of paper and ink. The page is white, text is near-black ink, and ink is the only solid fill. Gold never fills; it draws: the chosen day, the AI mark, focus, a hairline beside opened details. Rows are separated by 1px hairlines rather than boxed, containers and photos are square, and anything you press is a round pill. The one rounded surface is a sheet, the owner's Apple-style exception. The flag's own colours appear in two places only, by the owner's request: a thin band across the top of the page and the flag mark that leads the first screen's title (the Tricolore Rule).

Rank lives in TikTok Sans's width axis, not in weight. The widest cut carries the page title, a wide cut carries day headings and place names, and the condensed cut carries times and labels in tabular figures, like a printed station board. Weight marks state and emphasis. Checked facts stand upright; the one line of commentary per stop leans on the slant axis.

Motion starts at the top left: the flag's band draws across the top of the page as it opens, the flag mark's bands drop in and one breath of wind ripples through it from the hoist to the fly, a fold of light and shade travelling with it, and the rail diagram draws from Milan down to Rome. Then the split-flap arrival. When a plan lands, each row's times drop from a top hinge into place while the rest of the row rises in, in a sweep from the top left to the bottom right. After an edit, only the times that moved flip, and the touched row glows gold and fades. Sheets rise on a smooth spring over a dimmed, softly blurred page, and on a phone the page behind scales back as on iOS. Every animation moves only transform and opacity, and reduced motion swaps each of them for a short crossfade or nothing. The whole world has a real dark mode, where ink and paper trade places and gold lightens.

**Key Characteristics:**
- Paper and ink, with ink as the one solid fill.
- Gold draws and marks; it does not fill (one exception, the count badge).
- The flag's colours on the top band and the flag mark only.
- Hairlines between rows; boxes are rare.
- Square containers, inputs and photos; round pills for anything pressed; rounded corners on sheets only.
- No navbar in the plan view: the trip's dates are the page heading.
- Width as rank: 150, 125, 112.5, 87.5.
- Split-flap arrival in a top-left to bottom-right sweep.
- Light and dark, both checked to WCAG AA for every text pair.

## Colors

A near-monochrome paper and ink palette with one warm gold and a caution yellow, each role defined for light and dark in one set of semantic custom properties. The flag's own colours are kept apart for the flag alone (the Tricolore Rule).

### Primary
- **Ink** (ink, fill): all body text, the meal role that starts a stop's subtitle, the day header rule, and the one solid fill: "Plan my trip", the chosen pace, chosen choice chips, map stop discs, the toast. Dark mode inverts it to warm paper (#f3f2ec) with ink text on it.
- **Ink hover** (fill-hover): the fill under a pointer.

### Secondary
- **Gold** (gold): marks that are not text. The day-tab indicator, the AI reason dot, the ring of the AI source check, the inset bar on the chosen search option, the rule beside source details, underline colour on hover. Dark #c29d55.
- **Gold text** (accent, focus): gold when it must be read, at 5.9:1 on the page. The tick of the AI source check, the caret, and every focus ring. Dark #d8bd82.
- **Gold paper** (gold-soft): the count badge, text selection, and the base of the edited-row flash (22% in light, gold at 14% in dark). Dark #5a4a2a.
- **Gold wash** (accent-soft): a chosen option's background. Dark #2a261c.

### Tertiary
- **Caution** (warn): the fill of warning chips and the square marker before a note or an unconfirmed fact, always with ink text. Dark #e3c46a.
- **Danger** (danger): error text, error hairlines and the danger dot. Dark #f2837a. **Danger soft** (danger-soft) is its quiet background.

### Neutral
- **Page** (page) and **Surface** (surface): the white page and the white of inputs and sheets. Behind a phone sheet the page scales back over a black surround (`--recede-surround`, #000000), which shows only while it recedes. Dark #11110f and #1b1b18.
- **Warm paper** (surface-warm): photo mats, opened details, chip explanations, note banners. Dark #1f1e1a.
- **Tile** (tile): a photo that has not loaded. Dark #1f1f1c.
- **Muted** (muted): secondary text, end times, the reason line, credits, inactive tabs, at 5.45:1. Dark #a3a197.
- **Hairline** (line): row dividers and frames, decorative only. Also the skeleton tone. Dark #34332d.
- **Strong hairline** (line-strong): input, chip and outline pill borders, the rule beside a listing's own words, and the sheet grabber, at 3.8:1. Dark #75736a.
- **Hover** (hover): the hover wash on quiet and outline controls. Dark #25241f.

### The flag (the Tricolore)
- **Flag green, flag white, flag red** (flag-green #008c45, flag-white #f4f5f0, flag-red #cd212a): the Italian government's specification, the decree of the President of the Council of Ministers of 14 April 2006, article 31, as published by the Presidency's Ceremonial Office in "La Bandiera": Pantone textile 17-6153 (Fern Green), 11-0601 (Bright White) and 18-1662 (Flame Scarlet). The hex values are Pantone's own sRGB for those three. The flag is the flag in both schemes: dark mode keeps the same values.
- **Flag edge** (flag-edge): the hairline (line) along the white band's edge, so on white paper the band reads green, white, red and not green, gap, red. Transparent in dark mode, where the white band stands out on its own.

### Named Rules
**The Tricolore Rule.** The flag's colours appear in two places and nowhere else, by the owner's request: the band across the top of the page (4px, green, white and red in equal thirds, under the status bar, on the first screen and the plan alike) and the flag mark that leads the first screen's title (the flag's 2:3 at the title's cap height, square). They are never UI colours: no green for success, and errors keep their own danger red; gold remains the accent everywhere else. The band draws in once from the left and the mark's bands drop in, before one breath of wind ripples through it and it rests flat. The wind lays paper and ink over the colours at low opacity, lit where the cloth turns up toward the top left and shaded where it falls away, and at nothing once the flag is flat; never a flag colour anywhere else. Reduced motion shows both at rest, with no draw and no wave. Both are decoration, hidden from assistive technology.

**The One Fill Rule.** Ink is the only solid fill on the page. Primary actions, chosen states and markers take ink; nothing else is filled except the caution chip and the count badge. Small marks (dots, the caution square, the sheet grabber) are marks, not fills.

**The Gold Draws Rule.** Gold is a line, a dot, a bar, an underline or a focus ring. The count badge (gold paper under ink) is the one place gold fills.

**The Danger Never Fills Rule.** An error is danger text, a danger hairline and a danger dot. It never takes a red background, and colour is never the only sign: a chip says what is wrong.

## Typography

**Display Font:** TikTok Sans (with TikTok Sans Fallback, a metric-matched Arial, then system-ui)
**Body Font:** TikTok Sans, the same family
**Label/Mono Font:** none; labels and times use the condensed width with tabular figures

**Character:** one variable family doing every job through its width, weight, optical size and slant axes. Width says how important a line is; weight says what state it is in.

### Hierarchy
- **Display** (400, width 150): the page title before a plan, and the day heading from 640px.
- **Headline** (400, width 125): the day heading on phones and page message titles.
- **Title** (500, width 125): place names on the board, the trip's dates as the plan view's heading (tabular figures), and sheet titles.
- **Tab** (500, width 112.5): day tab names and highlight place names.
- **Time** (600, width 87.5, tabular figures): start times in the board's time column. End times sit under them in muted 400 at 0.9375rem.
- **Body** (400): the default for prose; opened descriptions run 0.9375rem at 1.5 within 62ch.
- **Body small** (400): facts, hints, the reason line, the source line under the trip heading, and fact values in a stop's details sheet. The subtitle under a place name starts with its meal role in ink at 500 ("Lunch, restaurant in Monti"), then the area in muted. Photo credits under highlights drop to 0.75rem.
- **Label** (600, width 87.5, 0.02em): field labels, the highlights heading, fact terms in a stop's details sheet (muted), photo chips, the count badge and map stop numbers. Never uppercase.

### Named Rules
**The Width Is Rank Rule.** Change width to change importance. Use 150, 125, 112.5 and 87.5, and leave weight for state.

**The Tabular Numbers Only Rule.** Times, dates, durations and counts get tabular figures; prose does not, because the feature widens commas and periods in this font.

**The Commentary Leans Rule.** Checked facts stand upright. The one line of commentary per stop is set at a 6deg oblique.

## Layout

One centred column on every screen, kept inside the safe areas. Both views open with the flag's band, 4px, under the status bar; it scrolls away with the page, so it never covers the pinned day tabs. Before a plan the column is narrow (column-compose); once a plan is on screen it widens (column-plan) and has no bar at the top. The trip header opens the plan view: the dates as the heading with the pace under them, Edit trip and Copy link at the right (on phones, one row of two equal pills under the pace), then one line saying how the plan was made, with Undo at its end after an edit. With no summary or notes between them, the day tabs follow the header without the tabs' own top margin. Its top space steps with the gutters (16px, 24px, 32px). The form lives in the Edit trip sheet once a plan exists.

Below 1024px the compose view's highlights follow the form as one row that scrolls sideways and snaps to each photo, bleeding to the screen edges so a cut-off photo says there is more (tiles min(56vw, 220px), 14px apart). From 1024px they sit beside the form as a grid: two columns and four photos, or three columns and six once the side column is 440px wide. Side gutters step from gutter-phone to gutter-tablet at 640px and gutter-desktop at 1024px, never less than the safe-area inset.

The board is a two-column grid: a fixed time column (64px, 84px from 640px) that holds only the times, and the row body, 14px apart. Inside a row one step (sm, 8px) separates the name group, chips, reason and actions, measured from the visible text rather than from the transparent top of a 44px target. A stop's details are md (14px) apart in their sheet. Travel legs are dashed hairlines in the time column. Day tabs pin under the status bar, one equal column per day, full bleed on phones. The map follows the board on phones and tablets in portrait and sits beside it from 1024px with a 40px gap.

Rhythm is tight inside a row (2px to 8px), md between rows and header parts, and lg between form fields. Every control is at least 44px tall and every text input uses a 16px font so iOS does not zoom. Breakpoints: 480px, 640px, 768px, 1024px.

## Elevation & Depth

Flat. Depth on the page is tonal: warm paper for opened and matted things, hairlines for separation. Only floating things cast shadows: the sheets, the toast and the search listbox. Each shadow token has a stronger dark value.

A sheet adds the one layered moment. Its backdrop is the scrim with a 10px blur (`--sheet-blur`). On phones the page behind scales to 0.94 (`--recede-page`) and drops toward the sheet, over the black surround. A sheet opened over another pushes that one back to 0.94 (`--recede-sheet`) and starts 24px lower (`--sheet-stack`) so the one beneath peeks out; the second backdrop only dims, without a second blur.

### Shadow Vocabulary
- **Float** (`--shadow-float`): the toast, the swap side sheet from 768px, and the centred sheet panel from 768px.
- **Sheet** (`--shadow-sheet`): bottom sheets on phones, cast upward.
- **Menu** (`--shadow-menu`): the place search listbox.
- **Scrim** (`--scrim`): the backdrop behind an open sheet, blurred behind the Edit trip and More options sheets.

### Named Rules
**The Only Floating Things Cast Shadows Rule.** A row, a card, an input or a photo never has a shadow. If it does not float over the page, it is flat.

## Shapes

Two shapes, and one named exception. Containers, inputs, choice chips, note chips, the listbox, the toast, banners and photos are square (0). Anything pressed is a pill (999px): buttons, the segmented pace control and its thumb, removable place tokens, stop actions, the count badge, the sheet grabber. Sheets round their corners (sheet, 20px): the top two on a phone bottom sheet, all four on the centred panel from 768px. Small status marks are dots (7px to 8px circles); the caution marker is a square. Map stops are 28px ink discs with a 2px paper ring; an approximate location is a paper disc with a dashed ink ring.

### Named Rules
**The Rounded Sheet Rule.** The sheets (Edit trip, More options and a stop's details) are the one rounded surface, at 20px, by the owner's explicit request for Apple-style sheets. The top corners round where a bottom sheet meets the screen edge; a centred panel rounds all four. Fields, containers and photos inside a sheet stay square, and nothing on the page rounds.

## Components

### Buttons
Round, calm and quick to answer a press.
- **Shape:** full pill (999px).
- **Primary:** "Plan my trip" is the page's one ink pill, full width at 52px, sticky at the bottom of the form while options scroll.
- **Pill set:** filled ink, outline (strong hairline border on surface) and quiet (no border, hover wash). Round icon pills are 44px square.
- **Trip header pills:** Edit trip and Copy link are outline pills with an icon and words at every width; on phones they share one row under the pace, each half its width. They are the page's main actions, so they are never reduced to glyphs. The copied check pops in on the snappy spring. While a plan is on its way (the first plan or one asked for from the Edit trip sheet) both dim to the disabled 40% and do nothing until it arrives or fails; they stay in the tab order with their names (aria-disabled), and Copy link never offers the plan before, nor a link to copy by hand left over from it.
- **Hover / Focus:** fills darken to fill-hover; outline and quiet pills take the hover wash. Presses scale to 0.97 (0.94 for round pills) over 100ms. Focus is a 2px focus-colour outline 2px out. Disabled drops to 40% opacity.
- **Text button:** ink text with a strong-hairline underline that turns gold on hover. "Start a new trip" is one, quiet at the foot of the Edit trip sheet with one muted line saying what it clears, never beside Plan my trip.

### Chips
- **Choice chips** (interests, bases): square, strong hairline border, ink border on hover, ink fill with paper text when chosen.
- **Note chips** on a stop: square, 26px, label weight. Caution chips fill with warn; notes carry a strong hairline; errors are danger text on a danger hairline. Tapping one opens an explanation on warm paper with a hairline down its left edge.
- **Tokens** (picked places): pills with an ink border and a remove control.

### Inputs / Fields
- **Style:** square, 48px, strong hairline border on surface, 16px text. Labels use the label role in ink above the field; hints are small muted text below.
- **Focus:** the border turns ink and a 2px focus outline sits 2px out.
- **Error / Disabled:** a danger border and a bold danger line below; disabled at 60% opacity.
- **Segmented control** (pace): a pill track with a 3px inset and one ink thumb that springs to the chosen segment. Labels only change colour, so text never reflows.

### Navigation
- **Day tabs:** equal columns under a hairline, pinned under the status bar. Name in the tab role, date below in small tabular figures. Inactive tabs are muted, the chosen tab is ink, and one 2px gold indicator springs between days. A new day's board slides in from the side it was reached from.
- **Trip header:** in place of a navbar. The dates in the title role, the pace in muted below, Edit trip and Copy link at the right, dimmed while a plan is on its way. Under it the source line in body small, its drawn check on the first line (gold ring and gold-text tick for the AI planner, ink for the rules), opening its details on warm paper beside a gold hairline; a quiet Undo pill sits at the line's end after an edit. It rises 6px on arrival.
- **More options:** a full-width row between hairlines with the count badge and a chevron pointing onward, which nudges 2px on hover; it opens a sheet.

### The departure board (signature)
Times alone in the fixed left column in the time role, the place name in the title role, then the subtitle (meal role in ink, then area), facts and the reason line with its source dot (filled gold for the AI planner, an open ring for the rules). Rows are separated by hairlines under an ink rule beneath the day header. A flagged stop turns its times danger and puts a danger dot before its name. At most two rows a day carry a 72px square thumbnail: the highest-rated stops with a photo of their own. The thumbnail is a button ("Photo and details for" the place) that opens the stop's details sheet. On a pointer it takes an ink hairline 2px out, where the focus ring sits, and its photo leans in 4% inside its square (the photo stays still under reduced motion); it presses to 0.97 like a pill.
- **Actions:** one line under the stop of quiet muted pills that turn ink on hover. Details (its chevron points onward, as it opens a sheet, and nudges 2px on hover), Swap and Remove, then the up and down pair at the right. On phones Swap and Remove are round icon pills (the swap arrows and a bin), with their words from 640px; the line wraps rather than pushing the page sideways.
- **Details sheet:** the photo and Details open the stop in a sheet over the board, never in the row, so the board stays one calm list. The place's name is the title with its subtitle under it; then the photo large (3:2, square corners inside the rounded sheet, a city or general photo still on its mat) with its credit, the facts for the date as a small board of hairline rows (the visit's times first, then the hours on that date, the dates it opens, booking and price; term in the muted label role, value in body small ink; side by side once the details are 380px wide, stacked below), then what the data cannot confirm as a list with caution squares, then the listing's own description, upright, set off by a strong hairline at its left. The parts drop in 28ms apart as the sheet arrives. It is for reading: Swap, Remove and the moves stay on the row. Closing gives focus back to the photo or button that opened it.
- **Arrival:** times flip from a top hinge (perspective 240px, from -88deg past flat to 6deg, then settle) over 320ms; the row body rises 8px; each row waits 42ms per row, capped at six rows.
- **After an edit:** only moved times flip; the edited row flashes the gold wash over 1200ms.

### Photos
Square thumbnails (72px on the board at every width, 96px from 640px elsewhere) and 3:2 wide photos, never rounded. A city or topic photo sits inset on a 6px warm-paper mat with a square label chip, so it is never mistaken for the place itself. Images fade in over 180ms on load, over the tile colour. Every photo carries a muted credit line. Under a highlight the credit is compact: "Photo: author, licence" in the label width (87.5), one line under most photos, with the full credit in its title. Nothing is cut: a longer credit wraps, the licence never breaks inside itself, and the highlight grid shares its photo, name, city and credit rows across each row (subgrid) so a wrapped name or credit keeps its row level.

### Map
Stops are ink discs with paper numbers; gold stays off the map. Discs closer than 22px centre to centre are nudged apart along the line between them, never more than 12px from their place, and ease back as the map zooms in. An earlier stop draws above a later one.

### Toast, sheets and banners
- **Toast:** square, ink, floating, centred, with a quiet Undo pill in gold text (toast-accent) and its own gold focus ring. It rises on the snappy spring.
- **Sheets** (Edit trip, More options, a stop's details): the native dialog, so focus is trapped, the page is inert and Escape closes. On phones a bottom sheet with a 36px grabber that rises on the smooth spring and can be dragged down to close; Edit trip reaches to 12px under the status bar; More options and a stop's details are as tall as their content, up to the same line. From 768px a centred panel up to 560px wide that scales from 0.96 and fades in. The head holds the title in the title role and a quiet round close pill; the body scrolls, and in Edit trip Plan my trip is the sticky footer. Side padding is 16px on phones and 28px from 768px. More options' fields drop in 28ms apart once the sheet is most of the way up. Exits are shorter than entrances, and reduced motion leaves a fade.
- **Swap sheet:** a bottom sheet on phones, a side sheet with a hairline edge from 768px, on the smooth spring over a scrim. Its alternatives rise in 28ms apart, capped at eight.
- **Banners:** square with a hairline; errors carry a danger hairline and dot, notes sit on warm paper with a caution marker.

## Do's and Don'ts

### Do:
- **Do** use ink as the only solid fill, and gold only as a line, dot, bar, underline or focus ring.
- **Do** separate rows with 1px hairlines instead of boxing them.
- **Do** keep containers, inputs, chips and photos square and make anything pressed a 999px pill; round only a sheet, at 20px.
- **Do** rank type by width (150, 125, 112.5, 87.5) and keep weight for state.
- **Do** set every time, date and count in tabular figures, and prose without them.
- **Do** move only transform and opacity, use the motion tokens, and give every animation a reduced-motion crossfade or none.
- **Do** define every new colour as a semantic custom property with a checked dark value.
- **Do** keep every control at least 44px tall and every text input at 16px.
- **Do** open the plan view with the trip header, not a navbar.
- **Do** keep the flag's colours to the top band and the flag mark, at the government's values.

### Don't:
- **Don't** fill with gold anywhere except the count badge.
- **Don't** give a row, card, input or photo a shadow; only floating things cast one.
- **Don't** round containers or photos (sheets are the one exception), and don't put a hero photo over a stack of rounded stop cards.
- **Don't** fill errors with red or rely on colour alone to say something is wrong.
- **Don't** uppercase labels, and don't put a label above a heading; a stop's meal role starts the line under its name.
- **Don't** present a city or topic photo full bleed as if it were the place.
- **Don't** show more than two thumbnails in a day's board.
- **Don't** use the flag's green or red as a UI colour, or put the flag anywhere but the top band and the flag mark.
- **Don't** open a stop's details inside its row; they open in the sheet.
