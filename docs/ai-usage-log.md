# AI usage log

How I used AI to build this project, dated, from the git history, [tasks.md](tasks.md) and
[decisions.md](decisions.md). All dates are 2026.

## Who did what

- I wrote the plan before any code: the scope, the architecture (the model proposes, code
  decides), the failure vectors the tests start from, the phases and the first task list. The
  plan stays out of the repository; [tasks.md](tasks.md) is its public trace.
- Claude Code agents wrote nearly all of the code, tests and docs from that plan: the data
  normalizer, the planner, the API, the web app, the infrastructure, CI, the evals and these
  documents. Several worked at once, each on its own branch or worktree, and I merged the work.
- I made the product, design and risk calls below, reviewed the results, did the steps that
  need the account owner (the API key, the first deploy), and drove the live site.
- At runtime the planner calls Claude Sonnet 5; Claude Haiku 4.5 is the comparison in the
  evals. Claude Opus 5.5 wrote the place summaries once, and code checks every one before it is
  saved (`scripts/generate-place-summaries.ts`).

## Phases

| Date | Phase | Main commits |
|---|---|---|
| 09-23 | Scaffold, CI workflows with pinned tools, the task log | be632ec, 526353a, 19ebc8f |
| 09-23 | Infrastructure: Terraform bootstrap and platform, the SAM stack | 17a2aea, 1d77cbe |
| 09-23 | Data: profile, normalizer, audit of 112 issues | 6a030ad |
| 09-23 | Planner: travel model, bases, scheduler, independent validator | a10684f, 0947974 |
| 09-24 | API and AI layer, web app, PWA, E2E on six devices, coverage floors | 3e49bf2, 13c1fd3, 89f435f, a856d20 |
| 09-24 | First deploy by hand, then automatic deploys from `main` | b080eac, f81dc9f |
| 09-24 | Planner rules measured by ablation; the eval harness; the docs | 8cb7665, 504ec03, ac3e79f |
| 09-24 | Redesign, place photos, self-hosted map | b43b600, cb38379, a706cb8, 1189a1c |
| 09-24 to 09-25 | The live AI path: thinking off, the tidy step, why lines, prompts v2 and v3 | 418afb3, cd1c501, f97d2ca, 6ccaa8c, 030ec00 |
| 09-25 | Saved trips and the plan cache; stop and place sheets, About this data, full-screen map | b2e6d65, 78d6a2a, 26fc9e6, 2eb8b06 |
| 09-25 | Live evals of Sonnet 5 and Haiku 4.5, README results, this log | 0219a78, a03235d |

## What I decided

- 09-23: the model only chooses and orders place ids from a shortlist. Code times every stop,
  and a validator written apart from the scheduler checks the result. The rules-only planner is
  a product path with a label, not an error page (decisions 1, 5 and 6).
- 09-23: the tests start from failure vectors, each with a guard in code and a named test
  (decision 11).
- 09-23: AWS, with Terraform and SAM applied by different roles, and the site at
  italy-planner.brdjx.com with a public API host (decisions 9 and 10, T57).
- 09-24: "code tidies, AI chooses". Code fixes what the model cannot see, such as a place on its
  closed day, before the check (decision 1).
- 09-24: a workspace-scoped Anthropic key, stored without ever being printed (T58).
- 09-24: E2E reports without blocking while the page is redesigned (T62, still open).
- 09-24: the design direction: the Goodpix language as the reference (T65), a self-hosted
  vector map instead of Google Maps (T67), and feedback that became T71 to T73.
- 09-25: "Saved trip, short link" for Copy link (decision 12, T77).
- 09-25: cache AI plans by the selected options, so the same options never pay for the model
  twice (decision 14, T79).
- 09-25: the tricolour band and flag mark, stop details in a sheet, and Edit trip disabled while
  a plan is on its way (T78).
- 09-25: the source line is one line of fact, not a disclosure.

## How I checked the output

An agent's work was never accepted because it looked right. Each kind of work had a check that
did not depend on the agent that wrote it.

- Tests named after failure vectors. [testing.md](testing.md) lists twelve (an invalid plan
  reaching a traveler, a hung model call, a leaked secret, runaway cost, a bad deploy, date bugs,
  and more), each with its guard in code and the tests that prove it holds.
- An independent validator. It never calls the scheduler: it rebuilds each day from the plan and
  derives every rule again. A mutation suite plants a corruption for every error code, and the
  validator must catch each one. Property tests run 500 times in every test run and 5,000 times
  with `pnpm test:props`.
- A record-by-record review of all 103 places against the normalizer's output (T10): 0
  mismatches.
- Numbers instead of taste for planner rules. Each heuristic was removed in turn and kept only
  when a metric moved on three seeds (T59, [planner.md](planner.md)); 25 rules went.
- Separate review agents. Adversarial reviewers with a fresh context were asked to find what
  was wrong with finished work, such as the three realism rounds on the planner (T14). Design
  review agents (`.claude/agents`) checked the redesign on phone and desktop screenshots.
- Live runs against the real model: the failure hunt over 56, then 69 request shapes (6ccaa8c,
  030ec00), and the eval suite ([latest.md](../packages/evals/results/latest.md)), whose
  recordings CI replays offline on every push.
- Driving the live site myself. My own request on 09-25 (Rome, balanced, from Friday 9 October)
  fell back to the rules-only plan: the model repeated days 1 and 2 on day 3, and the tidy step
  emptied that day. It drove the shortlist sized per trip, prompt v2 and the repair notes
  (6ccaa8c, T76). Live fallbacks went from 8% to 0 of 112.

## What the checks caught

- Sonnet 5 thinks by default, and on the plan request that pushed some answers past the 24 s
  deadline (measured 09-24). Thinking is off for this request (418afb3).
- On the 45 first answers of 09-25, 14 passed the check. Dropping the visits a day's hours
  cannot hold, in the tidy step, raised that to 43 (7c56ecb).
- A price of `__proto__` returned `Object.prototype` from a lookup table, found by fuzzing the
  normalizer. Lookups now ignore inherited keys.
- A review found both Trevi Fountain listings planned back to back. Two listings of one spot now
  never share a trip, and a test pins it.
- AI why lines could contradict the stop as timed. They now give way to the rule line on the
  server and after every edit (T74); sweeps over about 15,300 random edits found no false line.
- A plan made with the traveler's notes could repeat those private notes in a saved trip. Such
  a plan now keeps none of the AI's text (decision 13).
- The rules-only plan's first day could end without dinner (T75). A day still missing a meal now
  gives up its least valuable visit for it (800d94c).
