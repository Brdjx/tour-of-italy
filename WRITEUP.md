# 3 Days in Italy

Live at https://italy-planner.brdjx.com. Locally (Node 24, no key needed): `pnpm install && LLM_MODE=fixture pnpm dev`, then open http://localhost:3000.

## What I built and why

A traveler acts on a plan, so one that sends them to a museum on its closed day is worse than none. The data makes that easy: of 103 places, 33 list no hours, 8 open only in some months or on some days, and one is listed about 156 km from its city.

So my rule was: the model proposes, code decides. Claude picks a base for each day and orders place ids from a shortlist that code built. Code times every stop, and a validator that never calls the scheduler checks the plan. A failed check gets one repair turn. After that, or on a timeout or error, a full rules-only planner makes the plan. The same planner runs in the browser, which checks every edit and plans offline. The page says in one line how each plan was made.

The data is cleaned in code, and `data/italy.json` is never edited. The normalizer logs 112 issues of 23 kinds, shown under "About this data".

The traveler gets a day board with a time, travel and a reason for each stop. They can swap, remove, reorder and undo; swaps only offer places that keep the day valid. There is a map that opens full screen, credited photos of 73 places, and a Copy link that saves the trip as shown behind a short link.

## Judgment calls

- **Notes only tighten hours.** A wrong "open" sends someone to a closed door. A wrong "closed" hides one option.
- **Five base cities, at most two a trip, straight-line travel.** No routing API: free, deterministic and offline, but not a timetable.
- **Tidied plans are labelled.** The page says "fixed after a check", and the evals still count the fix as the model's mistake.
- **One repair turn.** A plan gets 24 s under API Gateway's 30 s cap. Live repairs took 2.6 to 8 s, with one past its limit, so one fits and two do not.
- **Notes stay private.** A trip planned with notes shares no AI text, since the model can echo the notes in its own words.
- **Left out:** accounts, and holiday hours beyond what the data states.

## Results

Live evals on 16 cases, recorded and replayed through the current code on every CI run ([packages/evals/results/latest.md](packages/evals/results/latest.md)):

| Planner | Valid as written | Valid after tidying | Fell back | Median / slowest | Cost per plan | Days missing a meal |
|---|---|---|---|---|---|---|
| Sonnet 5 (default), 48 plans | 4% | 100% | 0% | 8.1 / 10.5 s | $0.024 | 26% |
| Haiku 4.5, 32 plans | 22% | 72% | 6% | 5.8 / 14.4 s | $0.013 | 72% |
| Rules-only, 16 plans | n/a | n/a | n/a | no model call | $0 | 19% |

- Every plan a traveler gets passes the validator, in every row.
- Valid as written is low by design: the model never sees the time its order gives each stop, so a place often lands at an hour it is closed. An early live eval fell back to rules-only on 35 of 45 plans. I moved that work into a tidy step that drops, reorders or moves the model's own choices and never adds one, then resized the shortlist and rewrote the prompt and repair message.
- AI plans still miss a lunch or dinner more often than rules-only plans (26% of days against 19%). Haiku is faster at the median but misses a meal on most days, so Sonnet stays the default.
- A rules-only plan takes 3.4 ms at the median. 3,130 unit and integration tests and 312 end-to-end tests run on every push, and both block the deploy.

## How I used AI

**In the product.** Claude Sonnet 5 chooses and orders place ids, and writes a reason per stop and a summary. It never writes a time, and an id outside the shortlist is an error. It answers through structured outputs, parsed again with Zod. Thinking is off: with it on, the same request took 10 s once and 24 s the next time, past the deadline, and picking ids needs little reasoning. Each reason is checked against the stop as timed, so "a memorable dinner" on a lunch stop becomes a rule reason. Place summaries were written once by Claude, and code refuses any with a number, name, time or claim word the listing lacks.

**To build it.** Claude Code agents wrote nearly all of the code, tests and docs. They worked phase by phase from my written plan, stopping at checkpoints for my review. The calls that shaped it were mine: "the model proposes, code decides", in the plan before any code; "code tidies, AI chooses", on 2026-09-24, when the live model kept failing on things it could not see; a self-hosted map over Google Maps; and what to ship and what to cut.

Agents wrote the tests too, so I leaned on checks that do not just restate the code: tests named after the failure they prevent, property tests that check the validator agrees with the scheduler, a mutation suite with a corruption for every error code, live runs against the real model, separate review agents told to find faults, an independent record-by-record check of all 103 places, and using the live site myself. On 2026-09-25 my own Rome trip fell back when day 3 reused places from days 1 and 2. That led to the shortlist and prompt fix.

Agents wrote it faster than I could type it; the design is mine, and I can build each part by hand. What speed cost: `tidy.ts` grew past the roughly 250-line files my plan asked for, and the end-to-end suite fell behind the redesign until I rewrote it. This note was drafted with AI and edited by me.

## What I would do with more time

1. An eval of ordinary traveler notes against the rules-only plan. I cannot yet show AI plans are better.
2. Close the meal gap: AI days miss a meal more often than rules-only days.
3. Split `tidy.ts` by rule and remove rules by measurement, as I did for the planner.
4. A "plan another version" button. The same options give the same cached plan, which is cheap and testable; variety should be something the traveler asks for, with each version cached on its own.
5. Alarms on AI quality in production, such as missed meals. (Model spend already has a workspace cap.)
6. A routing API instead of straight-line bands, and the accessibility and dietary data the dataset lacks.

## Time spent

About 6 hours of my own time, spent steering agents; the agents ran across about two and a half days (commits from 23 to 25 September 2026). I treated it as a small production product, because it is public, pays for every model call, and gives people times they will act on.
