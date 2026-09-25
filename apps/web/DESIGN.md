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
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.fill-fg}"
    rounded: "{rounded.square}"
    padding: "4px 4px 4px 16px"
---

# Design System: 3 Days in Italy

## Overview

**Creative North Star: "The Departure Board"**

Each day is a board you check once and trust, drawn in the Goodpix language of paper and ink. The page is white, text is near-black ink, and ink is the only solid fill. Gold never fills; it draws: the chosen day, the AI mark, focus, a hairline beside opened details. Rows are separated by 1px hairlines rather than boxed, containers and photos are square, and anything you press is a round pill.

Rank lives in TikTok Sans's width axis, not in weight. The widest cut carries the page title, a wide cut carries day headings and place names, and the condensed cut carries times and labels in tabular figures, like a printed station board. Weight marks state and emphasis. Checked facts stand upright; the one line of commentary per stop leans on the slant axis.

Motion is the split-flap arrival. When a plan lands, each row's times drop from a top hinge into place while the rest of the row rises in, in a sweep from the top left to the bottom right. After an edit, only the times that moved flip, and the touched row glows gold and fades. Every animation moves only transform and opacity, and reduced motion swaps each of them for a short crossfade or nothing. The whole world has a real dark mode, where ink and paper trade places and gold lightens.

**Key Characteristics:**
- Paper and ink, with ink as the one solid fill.
- Gold draws and marks; it does not fill (one exception, the count badge).
- Hairlines between rows; boxes are rare.
- Square containers, inputs and photos; round pills for anything pressed.
- Width as rank: 150, 125, 112.5, 87.5.
- Split-flap arrival in a top-left to bottom-right sweep.
- Light and dark, both checked to WCAG AA for every text pair.

## Colors

A near-monochrome paper and ink palette with one warm gold and a caution yellow, each role defined for light and dark in one set of semantic custom properties.

### Primary
- **Ink** (ink, fill): all body text, the day header rule, and the one solid fill: "Plan my trip", the chosen pace, chosen choice chips, map stop discs, the toast. Dark mode inverts it to warm paper (#f3f2ec) with ink text on it.
- **Ink hover** (fill-hover): the fill under a pointer.

### Secondary
- **Gold** (gold): marks that are not text. The day-tab indicator, the AI reason dot, the inset bar on the chosen search option, the rule beside source details, underline colour on hover. Dark #c29d55.
- **Gold text** (accent, focus): gold when it must be read, at 5.9:1 on the page. Meal labels on the board, the caret, and every focus ring. Dark #d8bd82.
- **Gold paper** (gold-soft): the count badge, text selection, and the base of the edited-row flash (22% in light, gold at 14% in dark). Dark #5a4a2a.
- **Gold wash** (accent-soft): a chosen option's background. Dark #2a261c.

### Tertiary
- **Caution** (warn): the fill of warning chips and the square marker before a note, always with ink text. Dark #e3c46a.
- **Danger** (danger): error text, error hairlines and the danger dot. Dark #f2837a. **Danger soft** (danger-soft) is its quiet background.

### Neutral
- **Page** (page) and **Surface** (surface): the white page and the white of inputs and sheets. Dark #11110f and #1b1b18.
- **Warm paper** (surface-warm): photo mats, opened details, chip explanations, note banners. Dark #1f1e1a.
- **Tile** (tile): a photo that has not loaded. Dark #1f1f1c.
- **Muted** (muted): secondary text, end times, the reason line, credits, inactive tabs, at 5.45:1. Dark #a3a197.
- **Hairline** (line): row dividers and frames, decorative only. Also the skeleton tone. Dark #34332d.
- **Strong hairline** (line-strong): input, chip and outline pill borders, at 3.8:1. Dark #75736a.
- **Hover** (hover): the hover wash on quiet and outline controls. Dark #25241f.

### Named Rules
**The One Fill Rule.** Ink is the only solid fill on the page. Primary actions, chosen states and markers take ink; nothing else is filled except the caution chip and the count badge.

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
- **Title** (500, width 125): place names on the board and the compact app title in the plan view.
- **Tab** (500, width 112.5): day tab names and highlight place names.
- **Time** (600, width 87.5, tabular figures): start times in the board's time column. End times sit under them in muted 400 at 0.9375rem.
- **Body** (400): the default for prose; opened descriptions run 0.9375rem at 1.5 within 62ch.
- **Body small** (400): facts, hints, credits and the reason line.
- **Label** (600, width 87.5, 0.02em): field labels, meal labels, photo chips, the count badge and map stop numbers. Never uppercase.

### Named Rules
**The Width Is Rank Rule.** Change width to change importance. Use 150, 125, 112.5 and 87.5, and leave weight for state.

**The Tabular Numbers Only Rule.** Times, dates, durations and counts get tabular figures; prose does not, because the feature widens commas and periods in this font.

**The Commentary Leans Rule.** Checked facts stand upright. The one line of commentary per stop is set at a 6deg oblique.

## Layout

One centred column on every screen, kept inside the safe areas. Before a plan the column is narrow (column-compose); once a plan is on screen it widens (column-plan). From 1024px the compose view widens too, with the form held in its narrow column and real place highlights beside it. Side gutters step from gutter-phone to gutter-tablet at 640px and gutter-desktop at 1024px, never less than the safe-area inset.

The board is a two-column grid: a fixed time column (64px, 84px from 640px) and the row body, 14px apart. Travel legs are dashed hairlines in the time column. Day tabs pin under the status bar, one equal column per day, full bleed on phones. The map follows the board on phones and tablets in portrait and sits beside it from 1024px with a 40px gap.

Rhythm is tight inside a row (2px to 8px), md between rows and header parts, and lg between form fields. Every control is at least 44px tall and every text input uses a 16px font so iOS does not zoom. Breakpoints: 480px, 640px, 768px, 1024px.

## Elevation & Depth

Flat. Depth on the page is tonal: warm paper for opened and matted things, hairlines for separation. Only floating things cast shadows: the swap sheet, the toast and the search listbox. Each shadow token has a stronger dark value.

### Shadow Vocabulary
- **Float** (`--shadow-float`): the toast and the side sheet from 768px.
- **Menu** (`--shadow-menu`): the place search listbox.
- **Scrim** (`--scrim`): the backdrop behind an open sheet.

### Named Rules
**The Only Floating Things Cast Shadows Rule.** A row, a card, an input or a photo never has a shadow. If it does not float over the page, it is flat.

## Shapes

Two shapes only. Containers, inputs, choice chips, note chips, the listbox, the toast, banners and photos are square (0). Anything pressed is a pill (999px): buttons, the segmented pace control and its thumb, removable place tokens, stop actions, the count badge. Small status marks are dots (7px to 8px circles); the caution marker is a square. Map stops are 28px ink discs with a 2px paper ring; an approximate location is a paper disc with a dashed ink ring.

## Components

### Buttons
Round, calm and quick to answer a press.
- **Shape:** full pill (999px).
- **Primary:** "Plan my trip" is the page's one ink pill, full width at 52px, sticky at the bottom of the form while options scroll.
- **Pill set:** filled ink, outline (strong hairline border on surface, used for Edit trip, Copy link, Back to plan) and quiet (no border, hover wash). Round icon pills are 44px square.
- **Hover / Focus:** fills darken to fill-hover; outline and quiet pills take the hover wash. Presses scale to 0.97 (0.94 for round pills) over 100ms. Focus is a 2px focus-colour outline 2px out. Disabled drops to 40% opacity.
- **Text button:** ink text with a strong-hairline underline that turns gold on hover.

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
- **Trip summary:** the folded form as one line of tabular dates and pace with Edit trip, between hairlines.

### The departure board (signature)
Times in the fixed left column in the time role, the place name in the title role, then area, facts and the reason line with its source dot (filled gold for the AI planner, an open ring for the rules). Rows are separated by hairlines under an ink rule beneath the day header. A flagged stop turns its times danger and puts a danger dot before its name. Stop actions are quiet muted pills that turn ink on hover; their icons nudge toward what they do. Opening a stop reveals its photo, credit and description in place, capped at 560px.
- **Arrival:** times flip from a top hinge (perspective 240px, from -88deg past flat to 6deg, then settle) over 320ms; the row body rises 8px; each row waits 42ms per row, capped at six rows.
- **After an edit:** only moved times flip; the edited row flashes the gold wash over 1200ms.

### Photos
Square thumbnails (72px, 96px from 640px) and 3:2 wide photos, never rounded. A city or topic photo sits inset on a 6px warm-paper mat with a square label chip, so it is never mistaken for the place itself. Images fade in over 180ms on load, over the tile colour. Every photo carries a muted credit line.

### Toast, sheets and banners
- **Toast:** square, ink, floating, centred, with a quiet Undo pill in gold text (toast-accent) and its own gold focus ring. It rises on the snappy spring.
- **Swap sheet:** a bottom sheet on phones, a side sheet with a hairline edge from 768px, on the smooth spring over a scrim. Its alternatives rise in 28ms apart, capped at eight.
- **Banners:** square with a hairline; errors carry a danger hairline and dot, notes sit on warm paper with a caution marker.

## Do's and Don'ts

### Do:
- **Do** use ink as the only solid fill, and gold only as a line, dot, bar, underline or focus ring.
- **Do** separate rows with 1px hairlines instead of boxing them.
- **Do** keep containers, inputs, chips and photos square and make anything pressed a 999px pill.
- **Do** rank type by width (150, 125, 112.5, 87.5) and keep weight for state.
- **Do** set every time, date and count in tabular figures, and prose without them.
- **Do** move only transform and opacity, use the motion tokens, and give every animation a reduced-motion crossfade or none.
- **Do** define every new colour as a semantic custom property with a checked dark value.
- **Do** keep every control at least 44px tall and every text input at 16px.

### Don't:
- **Don't** fill with gold anywhere except the count badge.
- **Don't** give a row, card, input or photo a shadow; only floating things cast one.
- **Don't** round containers or photos, and don't put a hero photo over a stack of rounded stop cards.
- **Don't** fill errors with red or rely on colour alone to say something is wrong.
- **Don't** uppercase labels, and don't put a label above a heading unless it carries data, as the meal label does.
- **Don't** present a city or topic photo full bleed as if it were the place.
