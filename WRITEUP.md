# 3 Days in Italy

Live at https://italy-planner.brdjx.com. To run it on your machine with no API key, see the [README](README.md#run-it-locally).

## What it does

You pick a start date, a pace and what you enjoy (art, food, history and so on). You can also choose cities, places you must see, places to skip, and add a note. In about 10 seconds you get three days as a timetable: when to arrive at each place, how long to stay, how to get there, and why it was picked. Lunch and dinner are in it.

Then you make it yours:

- Swap, remove or reorder a stop. Swaps only offer places that still fit the day, and Undo takes back any change.
- Change the city of any day, even a different city each day. Before you confirm, the page shows the train time and how much of each day is left. Then it plans only the days that change, never repeating a place, and one Undo takes it all back. You can also ask for new ideas for a day.
- Open a stop for its photo, its hours on that date and a short summary, or open the map full screen.
- Copy link saves the trip exactly as you see it.

It installs as an app on a phone, and it still plans with no connection.

## Why you can trust the times

A plan that sends you to a museum on its closed day is worse than no plan, and the data makes that easy: of 103 places, 33 list no hours, 8 open only in some months or on some days, and one is listed 156 km from its city.

- **The data is cleaned in code** and never edited by hand. The 112 issues found are listed under "About this data". A note in the data can make hours stricter, never looser: a wrong "open" sends you to a closed door, a wrong "closed" only hides one option.
- **The model proposes, code decides.** Claude chooses the places and their order, from a list code built of places open on those dates. Code works out every time and travel leg, and a separate checker tests the whole plan. If it fails, Claude gets one chance to fix it. After that, or if Claude is slow or down, a rules-only planner makes the plan. Every plan you see has passed the checker.
- **The page says how each plan was made:** with AI, with AI and fixed after a check, or by the rules.

## How well it works

Live tests on 16 trips ([full results](packages/evals/results/latest.md)):

- Claude Sonnet 5 plans passed the checker 48 times out of 48, with no fallback, in 8 seconds at the median, for about 2 cents each.
- Only 4% were valid exactly as the model wrote them. The model never sees the time each stop lands at, so code tidies the plan first, and the tests still count that as the model's mistake.
- The honest gap: AI days miss a lunch or dinner more often than rules-only days (26% against 19%). Claude Haiku 4.5 was faster at the median but missed a meal on 72% of days, so Sonnet stays the default.
- Changing cities after a plan, 54 live days (single days and routes of up to three cities): no repeated place, no fallback, 3.3 to 5.5 seconds a day.
- 3,417 unit and integration tests and 354 browser tests run on every push, and a failure blocks the deploy.

## Choices I made

- **Travel is your call.** Plan my trip keeps to two cities and one move, since every train takes hours out of a day. If you want a city a day, you set it yourself and the page shows what the travel costs instead of refusing. A city is refused only when it would lose a place you asked for, or nothing would fit in the day.
- **Straight-line travel times.** No routing API: free, predictable and offline, but not a timetable.
- **The same options give the same plan.** AI plans are cached, which keeps them cheap and testable. You get variety by asking for it, with "New ideas for this day".
- **Your note stays private.** A shared trip planned with a note carries no AI text, since the model can repeat the note in its own words.
- **Left out:** accounts, and holiday hours beyond what the data states.

## How I used AI

**In the product.** Claude Sonnet 5 picks and orders places and writes a reason for each stop and a summary. It never writes a time, and a place outside its list is an error. Each reason is checked against the stop as timed, so "a memorable dinner" on a lunch stop is replaced. Place summaries were written once by Claude and checked by code against each listing.

**To build it.** Claude Code agents wrote nearly all of the code, tests and docs, working from my written plan and stopping at checkpoints for my review. The calls that shaped it were mine: "the model proposes, code decides" before any code; "code tidies, AI chooses" on 24 September, when the live model kept failing on things it could not see; a self-hosted map; and what to ship and what to cut. Since agents also wrote the tests, I relied on checks that do not just restate the code: live runs against the real model, property and mutation tests, review agents told to find faults, a record-by-record check of all 103 places, and using the site myself.

Agents wrote it faster than I could type it; the design is mine, and I can build each part by hand. What speed cost: one file (`tidy.ts`) grew too large, and the browser tests fell behind a redesign until I rewrote them. This note was drafted with AI and edited by me.

## With more time

1. Show that AI plans beat rules-only plans for real traveler notes. Today I cannot.
2. Close the meal gap.
3. Let Plan my trip suggest a city a day when asked. Today only the route view does that.
4. Real routes and transit times instead of straight-line estimates.
5. Alarms on AI quality in production, such as missed meals.
6. Accessibility and dietary information, which the data lacks.

## Time spent

About 6 hours of my own time, spent steering agents, while the agents ran across about two and a half days (commits from 23 to 26 September 2026). I treated it as a small production product, because it is public, pays for every model call, and gives people times they will act on.
