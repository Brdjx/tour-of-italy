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
  about-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    width: "760px"
  highlight-tile:
    textColor: "{colors.ink}"
    typography: "{typography.tab}"
    rounded: "{rounded.square}"
    width: "220px"
  place-summary-label:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
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
  map-stop:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.fill-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "44px"
  map-popup:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "10px 14px 2px 10px"
    width: "248px"
  map-expand:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "44px"
  map-dialog-head:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "10px 16px"
  step-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "44px"
  step-pill-head:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "44px"
  step-position:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
---

# Design System: 3 Days in Italy

## Overview

**Creative North Star: "The Departure Board"**

Each day is a board you check once and trust, drawn in the Goodpix language of paper and ink. The page is white, text is near-black ink, and ink is the only solid fill. Gold never fills; it draws: the chosen day, the AI mark, focus, a hairline beside opened details. Rows are separated by 1px hairlines rather than boxed, containers and photos are square, and anything you press is a round pill. The one rounded surface is a sheet, the owner's Apple-style exception. The flag's own colours appear in two places only, by the owner's request: a thin band across the top of the page and the flag mark that leads the first screen's title (the Tricolore Rule).

Rank lives in TikTok Sans's width axis, not in weight. The widest cut carries the page title, a wide cut carries day headings and place names, and the condensed cut carries times and labels in tabular figures, like a printed station board. Weight marks state and emphasis. Checked facts stand upright; the one line of commentary per stop leans on the slant axis.

Motion starts at the top left: the flag's band draws across the top of the page as it opens, the flag mark's bands drop in and one breath of wind ripples through it from the hoist to the fly, a fold of light and shade travelling with it, and the rail diagram draws from Milan down to Rome. Then the split-flap arrival. When a plan lands, each row's times drop from a top hinge into place while the rest of the row rises in, in a sweep from the top left to the bottom right. After an edit, only the times that moved flip, and the touched row glows gold and fades. Sheets rise on a smooth spring over a dimmed, softly blurred page, and on a phone the page behind scales back as on iOS. The day's map grows out of its frame to fill the screen on the same spring, a window opening onto a map that is never stretched, and shrinks back into its frame on the way out. Stepping to the next stop in a stop's details slides the new stop in from its side, like a new day's board, while the sheet and the photo's frame hold still. Every animation moves only transform and opacity, and reduced motion swaps each of them for a short crossfade or nothing. The whole world has a real dark mode, where ink and paper trade places and gold lightens.

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
- **Gold** (gold): marks that are not text. The day-tab indicator, the AI reason dot and the AI summary's dot, the ring of the AI source check, the inset bar on the chosen search option, the rule beside source details, underline colour on hover. Dark #c29d55.
- **Gold text** (accent, focus): gold when it must be read, at 5.9:1 on the page. The tick of the AI source check, the caret, and every focus ring, the one place gold touches the map (a focused stop's disc). Dark #d8bd82.
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
- **Body small** (400): facts, hints, the reason line, the source line under the trip heading, and fact values in a stop's or a place's sheet. The subtitle under a place name starts with its meal role in ink at 500 ("Lunch, restaurant in Monti"), then the area in muted; outside a plan it is the type, the neighbourhood and the city ("Historic site in Celio, Rome").
- **Label** (600, width 87.5, 0.02em): field labels, the highlights heading, fact terms in a stop's or a place's sheet (muted), "Summary by AI, from the listing" (muted), the table heads in About this data (muted), photo chips, the count badge and map stop numbers. Never uppercase.

### Named Rules
**The Width Is Rank Rule.** Change width to change importance. Use 150, 125, 112.5 and 87.5, and leave weight for state.

**The Tabular Numbers Only Rule.** Times, dates, durations and counts get tabular figures; prose does not, because the feature widens commas and periods in this font.

**The Commentary Leans Rule.** Checked facts stand upright. The one line of commentary per stop is set at a 6deg oblique, and so is a place's AI summary in its sheet: words the AI wrote lean, under a label that says so; the listing's own words stand upright beside their hairline.

## Layout

One centred column on every screen, kept inside the safe areas. Both views open with the flag's band, 4px, under the status bar; it scrolls away with the page, so it never covers the pinned day tabs. Before a plan the column is narrow (column-compose); once a plan is on screen it widens (column-plan) and has no bar at the top. The trip header opens the plan view: the dates as the heading with the pace under them, Edit trip and Copy link at the right (on phones, one row of two equal pills under the pace), then one line saying how the plan was made, with Undo at its end after an edit. With no summary or notes between them, the day tabs follow the header without the tabs' own top margin. Its top space steps with the gutters (16px, 24px, 32px). The form lives in the Edit trip sheet once a plan exists.

Below 1024px the compose view's highlights follow the form as one row that scrolls sideways and snaps to each photo, bleeding to the screen edges so a cut-off photo says there is more (tiles min(56vw, 220px), 14px apart, with 4px of room above and below so the hover hairline and the focus ring are never clipped). From 1024px they sit beside the form as a grid: two columns and four photos, or three columns and six once the side column is 440px wide. Each tile's photo, name and city sit on three rows the grid shares (subgrid), so a name that wraps keeps its row's cities level. Side gutters step from gutter-phone to gutter-tablet at 640px and gutter-desktop at 1024px, never less than the safe-area inset.

The board is a two-column grid: a fixed time column (64px, 84px from 640px) that holds only the times, and the row body, 14px apart. Inside a row one step (sm, 8px) separates the name group, chips, reason and actions, measured from the visible text rather than from the transparent top of a 44px target. A stop's details are md (14px) apart in their sheet. Travel legs are dashed hairlines in the time column. Day tabs pin under the status bar, one equal column per day, full bleed on phones. The map follows the board on phones and tablets in portrait and sits beside it from 1024px with a 40px gap.

Rhythm is tight inside a row (2px to 8px), md between rows and header parts, and lg between form fields. Every control is at least 44px tall and every text input uses a 16px font so iOS does not zoom. Breakpoints: 480px, 640px, 768px, 1024px.

## Elevation & Depth

Flat. Depth on the page is tonal: warm paper for opened and matted things, hairlines for separation. Only floating things cast shadows: the sheets, the toast, the search listbox, a map stop's popup and the full-screen map's day switcher. Each shadow token has a stronger dark value.

A sheet adds the one layered moment. Its backdrop is the scrim with a 10px blur (`--sheet-blur`). On phones the page behind scales to 0.94 (`--recede-page`) and drops toward the sheet, over the black surround. A sheet opened over another pushes that one back to 0.94 (`--recede-sheet`) and starts 24px lower (`--sheet-stack`) so the one beneath peeks out; the second backdrop only dims, without a second blur.

### Shadow Vocabulary
- **Float** (`--shadow-float`): the toast, the swap side sheet from 768px, and the centred sheet panel from 768px.
- **Sheet** (`--shadow-sheet`): bottom sheets on phones, cast upward.
- **Menu** (`--shadow-menu`): the place search listbox.
- **Popup** (`--shadow-popup`): a map stop's popup and the full-screen map's day switcher, the two things that float over the map. Small and close, 0 6px 18px -6px.
- **Scrim** (`--scrim`): the backdrop behind an open sheet, blurred behind every sheet (Edit trip, More options, a stop's or a place's details, About this data); a sheet over a sheet only dims.

### Named Rules
**The Only Floating Things Cast Shadows Rule.** A row, a card, an input or a photo never has a shadow. If it does not float over the page, it is flat.

## Shapes

Two shapes, and one named exception. Containers, inputs, choice chips, note chips, the listbox, the toast, banners and photos are square (0). Anything pressed is a pill (999px): buttons, the segmented pace control and its thumb, removable place tokens, stop actions, the count badge, the sheet grabber. Sheets round their corners (sheet, 20px): the top two on a phone bottom sheet, all four on the centred panel from 768px. Small status marks are dots (7px to 8px circles); the caution marker is a square. Map stops are 28px ink discs with a 2px paper ring inside a 44px round target; an approximate location is a paper disc with a dashed ink ring. A stop's popup is square with a hairline, like a container; Expand map, Close map and the full-screen day switcher are pills.

### Named Rules
**The Rounded Sheet Rule.** The sheets (Edit trip, More options, a stop's details, a place's details and About this data) are the one rounded surface, at 20px, by the owner's explicit request for Apple-style sheets. The top corners round where a bottom sheet meets the screen edge; a centred panel rounds all four. Fields, containers and photos inside a sheet stay square, and nothing on the page rounds.

## Components

### Buttons
Round, calm and quick to answer a press.
- **Shape:** full pill (999px).
- **Primary:** "Plan my trip" is the page's one ink pill, full width at 52px, sticky at the bottom of the form while options scroll.
- **Pill set:** filled ink, outline (strong hairline border on surface) and quiet (no border, hover wash). Round icon pills are 44px square.
- **Trip header pills:** Edit trip and Copy link are outline pills with an icon and words at every width; on phones they share one row under the pace, each half its width. They are the page's main actions, so they are never reduced to glyphs. While Copy link saves the trip, the pill keeps its shape and words and only its link mark fades (aria-busy), never a spinner. The copied check pops in on the snappy spring; when the saved link could not be made, one muted line under the header says which link was copied. While a plan is on its way (the first plan or one asked for from the Edit trip sheet) both dim to the disabled 40% and do nothing until it arrives or fails; they stay in the tab order with their names (aria-disabled), and Copy link never offers the plan before, nor a link to copy by hand or a line under the header left over from it.
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
- **Details sheet:** the photo and Details open the stop in a sheet over the board, never in the row, so the board stays one calm list. The place's name is the title with its subtitle under it; then the photo large (3:2, square corners inside the rounded sheet, a city or general photo still on its mat) with its credit, the place's AI summary (as in the place sheet, below), the facts for the date as a small board of hairline rows (the visit's times first, then the hours on that date, the dates it opens, booking and price; term in the muted label role, value in body small ink; side by side once the details are 380px wide, stacked below), then what the data cannot confirm as a list with caution squares, then the listing's own description, upright, set off by a strong hairline at its left. The parts drop in 28ms apart as the sheet arrives. It is for reading: Swap, Remove and the moves stay on the row. Closing gives focus back to the photo or button that opened it, or, after a step, to the Details of the stop now shown (below).
- **Stepping through the day:** Previous and Next move the sheet to the day's previous or next stop, meals included, without closing it, with the position between them ("3 of 6", the label role in muted, tabular, wide enough for "10 of 10"). On phones they are outline pills of one width ("Previous" and "Next" with their chevrons) in a bar pinned at the foot of the sheet, over a hairline, above the home indicator, where the thumb is. From 768px they are quiet round pills with the chevrons alone in the head beside Close, a hairline between them and Close. The pills say only the direction, and so do their accessible names ("Previous stop", "Next stop"): a pill as wide as each name would move under the thumb on every step, and a screen reader reads out a new name on the focused pill at once, so a name that carried the stop beyond would say one place as the sheet arrives at another. The live region says where the sheet is. At the first and the last stop the pill stays in place, dimmed to 40% and focusable (aria-disabled), so nothing moves. On a pointer the chevron leans 2px the way it goes. The bare left and right arrows step while focus is anywhere in the sheet but a control that moves with them (a field that takes text, a slider, a radio, a tab list or a menu), and focus stays on the control used (a focused credit link that steps away hands focus to the title; a focused pill that moves between the foot and the head as the width crosses 768px hands it to the same pill in its new place). On touch a sideways swipe on the body steps: its first 10px decide the axis, so a finger that sets off downward scrolls the body and one on the head closes the sheet, while one that sets off across follows the finger and steps when let go past 64px or on a flick; past the first or the last stop the body gives a quarter of the way and springs back. A second finger makes it a pinch, never a step: the body springs back and the browser zooms as it would anywhere. The sheet announces each step in a live region of its own ("Stop 4 of 6, Spanish Steps, 16:30 to 16:50", a meal says which), because the page's region is inert behind the modal sheet. The board's Details for the stop shown says it is the one open (aria-expanded), and the photos a step away load while the traveler reads. Closing after a step gives focus to the stop now shown, on what opened the sheet: its Details on the board, brought to the middle of the screen when it is off it (measured as laid out, and the page scales back around the top of what it now shows, so it grows in place), or its stop on the map, on the page or full screen; closed on the stop it opened on, focus goes back to the very photo, button or stop that opened it. The sheet is a viewer over the day's list, and the list is where the traveler has moved to.
- **Arrival:** times flip from a top hinge (perspective 240px, from -88deg past flat to 6deg, then settle) over 320ms; the row body rises 8px; each row waits 42ms per row, capped at six rows.
- **After an edit:** only moved times flip; the edited row flashes the gold wash over 1200ms.

### Photos
Square thumbnails (72px on the board at every width, 96px from 640px elsewhere) and 3:2 wide photos, never rounded. A city or topic photo sits inset on a 6px warm-paper mat with a square label chip, so it is never mistaken for the place itself. Images fade in over 180ms on load, over the tile colour; in a stop's details a step keeps the frame and fades the next photo in over the last (the Steady Sheet Rule). Every large photo carries its full credit in muted body small: "Photo: author, licence, Wikimedia Commons", the licence linked to its text and "Wikimedia Commons" to the photo's page, a city or general photo's note first in ink. Small photos carry no credit line: a highlight tile and a stop's thumbnail each open a sheet with the photo large and its full credit, and About this data lists every photo's credit. The photos are CC BY, CC BY-SA or public domain, whose attribution may be given "in any reasonable manner based on the medium"; one tap away, named on the tile ("photo, details and credit"), meets that.

### Highlight tiles
A few real places on the first screen, each one button: the square photo, the name in the tab role with a small muted chevron after it that points onward (it opens a sheet, like Details and More options), and the city in muted small text. Its name for assistive technology is "Colosseum, Rome: photo, details and credit". On a pointer an ink hairline draws round the photo 2px out (transparent at rest on every screen, so a screen that starts reporting a pointer never flashes it), the photo leans in 4% inside its square and the chevron nudges 2px; focus puts the gold ring round the whole tile, photo, name and city; a press scales the tile to 0.98. Under reduced motion the hairline still comes, and nothing moves. The tiles keep their diagonal sweep in from the top left, which ends unclipped (inset -4px) so the ring shows whole.

### Map
Stops are ink discs with paper numbers; gold stays off the map, except the focus ring around a focused stop's disc. Discs closer than 22px centre to centre are nudged apart along the line between them, never more than 12px from their place, and ease back as the map zooms in. An earlier stop draws above a later one.
- **Stops are buttons:** each disc sits in a 44px round target named like its row ("Stop 2, Borghese Gallery, 10:50 to 12:50, lunch"), in visiting order, so Tab walks the day. The drawing and its controls are hidden from screen readers; the timetable stays the text equivalent. The disc lifts to 1.08 under a pointer and while its popup shows.
- **Popup:** hovering a stop (after 250ms, like a tooltip), or focusing it from the keyboard, shows a small card: the number on a 22px disc, the place name in the tab role, the times in the time role, the role (a meal in ink at 500, a visit muted) and "Details" as a text button. Square, a hairline, surface paper and the popup shadow, because it floats. It sits 22px from the stop's centre, above, below, right or left of it, centred on it or lined up with its number level with the stop's, wherever it stays on the map (8px in from the edges, clear of Expand map, the landscape notch and the day switcher) and covers the fewest other stops, then the least of the route; it prefers above, then below, right and left, and never covers its own stop. Its stop draws above every other while it shows. The pointer can travel into it. Escape, a press elsewhere, a drag and a new day put it away; an Escape pressed elsewhere on the page still does its own work there too. On touch a tap shows it and a second tap opens the details, however quickly it follows: a tap on a stop or its popup never counts toward the map's double-tap zoom, while a drag or a pinch that starts on a stop still moves the map. A device that cannot hover never shows it on hover. A click or tap on it, a mouse click on the stop, or Enter on a focused stop opens the stop's details sheet, the same sheet the board's Details opens, and closing it gives focus back to the stop. It grows from its stop's side by 0.96 to 1 and fades in; under reduced motion it only fades. On a phone's page map a stop inside a tight cluster can still cover a neighbour, where no place that stays on the map clears them all; full screen spreads them apart.
- **Expand map:** a 44px outline round pill, 8px in from the top right corner of the page's map. The credits sit bottom right, and a corner is where a day's stops are least likely to be: when a stop, nudged or not, would reach the pill, the camera frames the day lower (82px of top padding instead of 40) so no stop is ever under it.
- **Full screen:** the native dialog with showModal, so the page is inert and a stop's details sheet stacks above it. A paper header with a hairline under it clears the status bar and the notch: the day ("Day 1, Fri 9 Oct, Rome") in the title role, the stop count in muted body small, and Close map (a round icon pill on phones, icon and words from 640px). The day switcher floats at the foot above the home indicator: the pace control's pill track and ink thumb, with the popup shadow; switching there switches the page's day too. The map takes every gesture there (no page to scroll), frames the day with room for the switcher, and the credits show in full from 1024px. Escape, the dialog's cancel and Close map shrink it back, and focus returns to Expand map. It is one map: the same MapLibre map moves from the page into the dialog and back, keeping its tiles, camera and stops; it draws its first full-screen frame in 30 to 45ms, where a second map would take 250 to 630ms to draw and 9.6MB (38MB at 2x) of drawing buffers.
- **Motion:** the dialog's frame grows from the page map's box to the screen on the smooth spring over 450ms and shrinks back over 340ms; the map inside it is scaled back by the inverse at every step, so it is never stretched and the growing window reveals more of it around the same centre. The camera glides to the full-screen framing as it grows and back to the page's framing as it shrinks, so it lands where the page's map carries on. The page fades to paper behind it; the header drops 8px and the switcher rises 8px into place as it finishes. Under reduced motion the dialog fades in over 180ms and out over 160ms, and the camera jumps.

**The Unstretched Map Rule.** The map is never scaled out of its proportions to animate it. Motion moves a window onto it, or its camera; its discs stay round and its labels stay upright at every frame.

### Place sheet
A highlight tile opens its place in a sheet, the stop details sheet's sibling built from the same parts (`components/PlaceParts.tsx`), with no visit and no date: the name as the title, "type in neighbourhood, city" under it; the photo large with its full credit; the AI summary, its label ("Summary by AI, from the listing") in the muted label role after the AI's gold dot, its one or two sentences leaning; the facts that hold on any date as the same hairline board (the typical visit; the hours by weekday as the data states them, days with the same hours run together from Monday, "Mon to Sat 09:00 to 19:00", "Sun Closed", tabular; the dates it opens; booking when the listing states it; price; rating); what the data cannot confirm with caution squares; and the listing's own description last, upright, beside its strong hairline. The parts drop in 28ms apart. Closing gives focus back to the tile. A place with no saved summary shows none: the summaries are written once by Claude from each place's own listing and each passed a code check before it was saved.

### About this data
"About this data" at the foot of both views is a text button that opens the data notes over a blurred page, never under the footer: on phones the tall bottom sheet, from 768px a wide centred panel (min(760px, 100% - 48px), all four corners at 20px) whose body scrolls on its own. It leads with how the data stands ("103 places loaded, all usable for planning.") in the tab role, then sections under hairlines, each with a heading in the tab role: the places by base (a table under an ink rule: base, its own city, its day-trip towns with counts, total; counts right-aligned and tabular) and by type (term and count on hairline rows in as many columns as fit); what was cleaned or flagged and why, kind by kind (title, count at the right in muted, the explanation, the places in muted small text; more than eight fold behind "Show all N"); how opening hours and notes are treated, with the counts by source; how a plan is made (what the AI chooses and writes and what code decides, the model named only when the health check names a Claude model); the place summaries (how many places have one, the model and the day that wrote them, from the saved file); every photo's credit, folded behind "Show every photo's credit", each with the work's title linked to its Commons page; and the map's credits. Every number is computed from the loaded data. Links underline in the strong hairline and turn gold on hover. The parts drop in 28ms apart; focus goes to the title and back to the link.

### Toast, sheets and banners
- **Toast:** square, ink, floating, centred, with a quiet Undo pill in gold text (toast-accent) and its own gold focus ring. It rises on the snappy spring.
- **Sheets** (Edit trip, More options, a stop's details, a place's details, About this data): the native dialog, so focus is trapped, the page is inert and Escape closes. On phones a bottom sheet with a 36px grabber that rises on the smooth spring and can be dragged down to close; Edit trip and About this data reach to 12px under the status bar; More options and a place's details are as tall as their content, up to the same line, and so is a stop's details on a day of one stop. On a day of several stops a stop's details takes the full height (Edit trip's line on phones, min(100dvh - 64px, 880px) from 768px), so a step never resizes it; nearly every stop fills it anyway (measured 788 to 832px of 832 at 390 by 844, 784 to 836 of 836 at 1440 by 900). A footer, when a sheet has one, is pinned under the scrolling body and carries the home indicator's inset. From 768px a centred panel up to 560px wide (About this data up to 760px) that scales from 0.96 and fades in. The head holds the title in the title role and a quiet round close pill; the body scrolls, and in Edit trip Plan my trip is the sticky footer. Side padding is 16px on phones and 28px from 768px. More options' fields drop in 28ms apart once the sheet is most of the way up. Exits are shorter than entrances, and reduced motion leaves a fade.
- **Swap sheet:** a bottom sheet on phones, a side sheet with a hairline edge from 768px, on the smooth spring over a scrim. Its alternatives rise in 28ms apart, capped at eight.
- **Banners:** square with a hairline; errors carry a danger hairline and dot, notes sit on warm paper with a caution marker.

**The Steady Sheet Rule.** Moving within a sheet never moves the sheet or its controls. Stepping between stops keeps the sheet's height and place, the head and the foot bar where they are, and the photo's frame where it is: the new photo fades in over the last, which waits 120ms and then fades out whether the new one has come or not, so no place ever wears another's photo on a slow connection. Only the words and the credit slide, 10px from the side the stop came from, over 220ms (the day panels' day-in); reduced motion fades them over 120ms and nothing follows the finger.

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
- **Do** open a stop's details from the map and the board into the same sheet, and give focus back to what opened it, or to the same kind of control for the stop the traveler stepped to.
- **Do** keep a sheet, its controls and its photo's frame still while its content changes; move only the content.

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
- **Don't** put a credit line under a small photo; the full credit belongs where the photo is large, one tap away.
- **Don't** show AI-written words without their label, upright, or as the listing's.
- **Don't** hide a Previous or Next that has nowhere to go; dim it in place.
- **Don't** stretch the map to animate it, or put a control where a stop can sit under it.
