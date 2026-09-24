# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- A traveler planning at home, on a laptop or a phone, before the trip: picks a start date and a pace, and optionally interests, a budget, bases to stay in, places to include and places to skip, and wants three days that actually fit.
- The same traveler on the phone in Italy: glances at today's stops, times, travel and map, sometimes on a poor connection or offline (the app installs and plans on the device).
- Hiring reviewers who open the live site to judge product sense, craft and judgment in a short session.

## Product Purpose

3 Days in Italy turns 103 curated places into a three-day itinerary whose times respect opening hours on the actual dates, meal windows, travel between stops and the chosen pace. Success means the traveler trusts the plan enough to follow it, can change it (swap, remove, reorder, undo) without breaking it, and can take it along (a share link, the installed app, offline).

## Positioning

Plans you can trust. The model proposes and code decides: Claude only picks and orders place ids from a shortlist the code built, the scheduler computes every time and travel leg, and an independent validator checks the result. A plan with an error never reaches the traveler; it is repaired once or replaced by the rules-only plan, and the page labels which one it is. The page also says what the data could not confirm (estimated hours, approximate locations, seasonal closures). A generic AI itinerary cannot truthfully claim any of this.

## Operating Context

- One page. Before a plan: the start date, the pace, "More options" (interests, budget, bases, must-see, skip, notes) and "Plan my trip". After a plan: a one-line trip summary with "Edit trip", day tabs, a timetable and a map per day, a source badge, stop actions (swap, remove, move up, move down, undo), a share link, and "About this data".
- Installable web app that plans on the device when the API cannot answer.
- Screens from a 375 px phone to desktop, phones and tablets in both orientations, light and dark.
- Live at https://italy-planner.brdjx.com.

## Capabilities and Constraints

- Data: `data/italy.json`, 103 places in five bases (Rome, Florence, Milan, Venice, Bologna) with day trips. The source file is never edited; a normalizer logs 112 issues of 23 kinds.
- Static Next.js export plus one API function, on one origin. A strict content security policy: fonts and images come from the site itself; the only third-party requests are OpenStreetMap map tiles.
- Dependencies come from an approved list; anything else is asked for first.
- Travel times come from a straight-line distance model, not a routing service.
- Terms in use: base, day trip, stop, pace (relaxed, balanced, packed), "Plan my trip", "Edit trip", "More options", "About this data", and the source badge labels ("Planned with AI, checked against hours and distance", "Planned without AI").

## Brand Commitments

- Name: 3 Days in Italy.
- Voice: plain, direct, sentence case. No em dashes, no marketing language, no emoji in UI copy.
- Typeface: TikTok Sans with every axis (weight, width, optical size, slant), self-hosted. Chosen by the owner on 2026-09-24.
- Motion: the owner wants refined micro-animations with Apple-level taste (2026-09-24). Motion explains a change of state and never delays the task, and reduced motion is always respected.
- Design reference: the owner chose the Goodpix main frontend (`/Users/brdjx/Dev/goodpix-monorepo/apps/main-frontend`, a local project) as the inspiration for the design direction. What is taken from it is decided in design work and recorded in DESIGN.md.

## Evidence on Hand

- `data/italy.json`: name, type, city, neighborhood, hours, typical visit length, price level, rating, description, coordinates and tags for each place.
- `docs/data-issues.md` and the in-app data notes; eval results in `packages/evals/results/latest.md`.
- The data has no photos. Photos come only from Wikimedia Commons: real, freely licensed, credited on each photo, downloaded once and served from the site. A place without a verified photo of itself gets a city or topic photo that is not presented as that place. No generated or stock images of real places.
- There are no testimonials, user numbers, reviews or press. Do not invent any.

## Product Principles

1. Never show a time the code has not checked.
2. Say what the data cannot confirm, in plain words, beside the stop it affects.
3. The plan is the product: the fewest inputs before the first plan, and everything after it is an edit.
4. Work where travelers are: on a phone, on a poor connection, offline.
5. Show real places truthfully: a photo is of the place it names, with its credit, or it is clearly a photo of the city or theme.

## Accessibility & Inclusion

WCAG 2.2 AA. Targets at least 44 px, inputs at least 16 px, reduced motion respected, every flow usable by keyboard alone, plan changes announced to screen readers, light and dark themes. These are enforced by the existing test suite.
