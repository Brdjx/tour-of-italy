# 3 Days in Italy

A trip planner that turns a list of 103 places in Italy into a three-day itinerary with times that respect opening hours, meals, and travel.

The submission note, on what I built, why, what I would do with more time, and how I used AI: [WRITEUP.md](WRITEUP.md). How it fits together, with a diagram of each flow: [docs/architecture/overview.md](docs/architecture/overview.md).

- Web app: https://italy-planner.brdjx.com
- Public API: https://api.italy-planner.brdjx.com (for example `/health`, `/places`, `POST /plan`, `POST /plan/day`, `POST /trips`, `GET /trips/<id>`; see [docs/deploy.md](docs/deploy.md#why-two-hostnames))

## Run it locally

You need Node 24 and pnpm 12.6 (`corepack enable` picks up the version pinned in `package.json`). No API key is needed.

```sh
pnpm install
LLM_MODE=fixture pnpm dev
```

Open http://localhost:3000 and press Plan my trip. This starts the API on http://localhost:8787 and the web app on port 3000. Both ports are fixed: the local API accepts the page only from port 3000.

How the trip gets planned depends on one setting:

| Setting | Who plans | Cost |
|---|---|---|
| `LLM_MODE=fixture` | Scripted model answers, no network. The page says "Planned with AI", but no model chose the places | Free |
| A key in `.env` (copy `.env.example`, set `ANTHROPIC_API_KEY`) | Claude Sonnet 5 | About 2 cents a plan |
| Neither, or `?mode=deterministic` on the page's address | The rules-only planner, labelled on the page | Free |

The map's background tiles are not in the repository (one 140 MB file, served from the site's bucket in production), so a local map draws the stops and routes on a blank background.

### Each part on its own

| Part | Command | Notes |
|---|---|---|
| API | `LLM_MODE=fixture pnpm --filter @italy/api dev` | Listens on 127.0.0.1:8787 and reloads on change. Reads `.env` at the repository root; shell variables win. |
| Web app | `pnpm --filter @italy/web dev` | Next.js on port 3000. It needs the API above for the places and plans. Set `NEXT_PUBLIC_API_BASE` in `apps/web/.env.local` to use another local port. |
| Production build | `pnpm build`, then `E2E_API_PORT=8787 node e2e/serve.mjs` | Builds the static site (`apps/web/out`) and the Lambda bundle (`services/api/dist`), then serves the site on http://127.0.0.1:14390 with `/api` passed to the local API, the way CloudFront does. |
| Planner | none, it is a library | `packages/planner` is plain TypeScript, used by both the API and the page. Run its tests with `pnpm test --project planner`. |

Try the API by hand:

```sh
curl localhost:8787/api/health
curl localhost:8787/api/places
curl -X POST localhost:8787/api/plan -H 'content-type: application/json' \
  -d '{"startDate":"2026-10-15","pace":"balanced","interests":["historic","food"]}'
curl -X POST 'localhost:8787/api/plan?mode=deterministic' -H 'content-type: application/json' \
  -d '{"startDate":"2026-10-15","pace":"balanced","interests":["historic","food"]}'
```

## Tests

| Command | What it runs | Time |
|---|---|---|
| `pnpm check` | Lint, typecheck, then every unit and integration test | about 1 min |
| `pnpm test` | 3,490 unit and integration tests in 212 files (Vitest) | under 1 min |
| `pnpm test --project <name>` | One area: `planner`, `api`, `web`, `evals` or `infra` | seconds |
| `pnpm test --project api planDay` | Only the test files whose path contains `planDay` | seconds |
| `pnpm test:coverage` | The same tests with a coverage floor per area, as in CI | about 1 min |
| `pnpm test:props` | The planner's property tests at 5,000 runs each | about 1.5 min |
| `pnpm test:e2e` | 372 Playwright tests on eight projects: phones, tablets, desktop and the installed app. Builds the site and starts the API with scripted answers, no key needed | about 5 min |
| `pnpm test:e2e route --project chromium-desktop` | One spec on one project. Add `E2E_SKIP_BUILD=1` to reuse the last build | 1 to 2 min, including the build |
| `E2E_BASE_URL=https://italy-planner.brdjx.com pnpm test:e2e:smoke` | The smoke tests against a deployed site | seconds |
| `pnpm eval:replay` | Replays the recorded model answers through the current code, no network, and rewrites the results | seconds |
| `pnpm eval --model claude-sonnet-5 --runs 1` | Live evals: the 16 cases against Claude, one after another. Needs a key and costs about 40 cents a run | about 3 min |
| `terraform -chdir=infra/terraform/platform init -backend=false && terraform -chdir=infra/terraform/platform test` | Terraform tests with mocked providers, no AWS account needed. The same for `infra/terraform/bootstrap` | about 1 min |
| `python3 .github/scripts/check-infra-contract.py .` | Checks that the SAM template and Terraform provide every name the deploy relies on, and that the trips table stays protected | seconds |

Install the browsers once before the first E2E run: `pnpm exec playwright install`. Tests are organized by what would break the product (an invalid plan, a hung model call, a leaked secret, runaway cost, a bad deploy), each with the guard in code and the tests that prove it. See [docs/testing.md](docs/testing.md).

## Results

Live evals on 16 cases, replayed through the current code. Full report: [packages/evals/results/latest.md](packages/evals/results/latest.md).

| Planner | Plans | Valid as written | Valid after tidying | Fell back | Model time, median / slowest | Cost per plan | Days missing a lunch or dinner | Before code added meals |
|---|---|---|---|---|---|---|---|---|
| Claude Sonnet 5 (default) | 48 | 2% (1/48) | 100% (48/48) | 0% (0/48) | 8.1 s / 10.5 s | $0.024 | 20% | 26% |
| Claude Haiku 4.5 | 32 | 6% (2/32) | 72% (23/32) | 6% (2/32) | 5.8 s / 14.4 s | $0.013 | 24% | 72% |
| Rules-only | 16 | n/a | n/a | n/a | no model call | $0 | 19% | n/a |

- Recorded on the evening of 2026-09-25 (the report shows the UTC date, 2026-09-26), prompt v3, production settings: 15 s per call, a 24 s deadline, at most one repair. Sonnet 5 ran each case 3 times, Haiku 4.5 twice.
- Every plan a traveler gets passes the validator: final valid is 100% in every row, and CI replays these recordings on every push and fails otherwise.
- Valid as written is low because code, not the model, times each stop. The model sees each place's opening hours but not the time its order gives each stop, so a place often lands at an hour it is closed (`CLOSED_AT_TIME`) or outside the day's window (`OUTSIDE_DAY_WINDOW`). The tidy step reorders or drops it before the check. The evals still count that as the model's mistake, and an answer code gave a meal is not as written either: 1 of Sonnet 5's plans and 5 of Haiku 4.5's passed the check untouched and then had a meal added.
- Valid after tidying: the first answer became the plan, with no repair turn and no fallback. Haiku 4.5 needed a repair on 9 plans, and 2 still fell back to the rules-only plan.
- Cases meeting every expectation, in the full report: Sonnet 5 0 of 16, Haiku 4.5 4, rules-only 10. Most cases forbid a stop at a closed hour and judge the answer as written, so a stop the tidy step fixed still fails its case. Two cases want the summary to say a request was not possible. Every answer said so, but the summary guard dropped that sentence each time: it drops any sentence with a capitalized word the place data never uses, such as Eiffel or Amalfi.
- The model leaves out more meals than the rules-only planner: as the answers passed the check, 26% of Sonnet 5's days and 72% of Haiku 4.5's lacked a lunch or a dinner, against 19%. Code then adds the meal a day lacks where the rules-only planner's meal fill seats a place the model was offered, keeping every stop the model chose in its order and role ([decision 17](docs/decisions.md#17-a-missing-meal-says-why-a-city-warns-before-and-code-adds-the-meal-the-ai-left-out)): 10 meals for Sonnet 5 and 47 for Haiku 4.5, leaving 20% and 24%. Only one of those days, Haiku's, had no place of the city open for the meal, before and after; on every other a place could have served it, most often one already on another day of the trip.
- Sonnet 5 stays the default: Haiku 4.5 is faster at the median, but it needed a repair on 9 of its 32 plans and fell back on 2, and it leaves out most meals itself.
- Costs are estimates from list prices checked on 2026-09-24 ($2 and $10 per million input and output tokens for Sonnet 5, $1 and $5 for Haiku 4.5). The whole run cost about $1.60.

## What it does

- Plans three days from a start date, a pace, interests, a budget, bases to stay in, places to include and places to skip. Each stop gets a time, the travel from the previous stop, and a reason.
- Checks every plan against opening hours on the actual dates, meal windows, travel time and the day's pace, and shows what the data could not confirm (estimated hours, approximate locations, seasonal closures). A day without lunch or dinner says why: no place of its city is open for it that date ("No dinner open", naming the places, with another city as the way out), or one could be but is not planned ("No dinner planned", with a swap that brings one in) ([decision 17](docs/decisions.md#17-a-missing-meal-says-why-a-city-warns-before-and-code-adds-the-meal-the-ai-left-out)).
- Lets the traveler swap, remove, reorder and undo stops, and re-checks each edit in the browser. It installs as an app and still plans offline.
- Sets the city of any day from the city on the day's line, up to a city a day, in any order and back again (Rome, Florence, Rome), or plans a new version of a day ("New ideas for this day"). Travel is the traveler's choice, stated as facts ("2 h 10 min by high-speed train from Rome, so the day starts at 11:40"), and so is a meal the city cannot give that day ("No dinner in Bologna on Mondays."); only the days that change city, or no longer fit their new start, are planned again, one request a day, and applied as one edit. Claude chooses each day from the places of its city open on that date that no other day has, and code times and checks the whole trip. A city is refused only when a place the traveler asked for would be lost or nothing fits the day, with the way out (`POST /api/plan/day`, decisions [15](docs/decisions.md#15-re-plan-one-day-of-a-trip) and [16](docs/decisions.md#16-a-city-a-day-set-by-hand)).
- Copy link saves the trip as shown, with the AI's why lines and summary, behind a short link, and the link opens it as saved.
- Opens each stop and highlight in a sheet (photo and credit, the facts for the date, the listing's own words), the day's map full screen, and About this data as an overlay with every note, source and credit.

## How planning works

```
TripRequest (checked with Zod)
  -> shortlist: up to 4 bases, and per base the best visits and meal places for the dates
  -> Claude selects: a base per day and ordered place ids, with a reason per stop (ids only)
  -> parse with Zod -> tidy what the model cannot see (closed days, repeats, the visit limit,
     an order the scheduler cannot time, visits the hours cannot hold) -> ids outside the
     shortlist are errors
  -> scheduler assigns every time -> independent validator
       no errors                    -> add the lunch or dinner a day lacks where a place the
                                       model was offered fits, each stop in its order and role
       no errors, nothing changed   -> source "ai"
       no errors, tidied or a meal
       added                        -> source "ai_repaired"
       errors                       -> one repair turn with the exact violations left
                                       -> tidied and validated again -> source "ai_repaired"
       still invalid, timeout,
       refusal, API error, no key   -> rules-only planner -> source "deterministic"
  -> response: itinerary, warnings, source, meta (fallback reason, attempts, latency)
```

The model proposes and code decides. Claude only chooses and orders place ids from a shortlist the code built; it never writes a time, a travel estimate or an opening hour. The scheduler times the chosen ids with the same rules the rules-only planner uses, and a validator that never calls the scheduler checks the result. Before the check, code tidies what the model cannot see because code assigns the times: it drops a place on its closed day, a repeat, and visits over the pace's limit, reorders a day the scheduler cannot time, and drops the latest visits a day's hours still cannot hold, keeping the model's bases, its must-includes and the day's meals. After the check, code adds a lunch or dinner a day lacks where the rules-only planner's meal fill seats a place the model was offered, keeping every stop the model chose in its order and role, and the plan is labelled fixed; where no place of the city is open for that meal (Bologna's dinner on a Monday), nothing is added. A plan with any error never reaches the traveler: the model gets one chance to fix what is left, and every other outcome falls back to the rules-only plan, which the page labels. The same planner package runs in the browser, so edits and share links are checked with the same rules, and the page plans on the device when the API cannot answer. More in [docs/architecture/overview.md](docs/architecture/overview.md), with a diagram for each flow, and in detail in [docs/architecture/reference.md](docs/architecture/reference.md); the planner's rules, and what each one buys, are in [docs/planner.md](docs/planner.md).

## Messy data

The source file `data/italy.json` is never edited. The normalizer keeps all 103 records and logs 112 issues of 23 kinds, listed record by record in [docs/data-issues.md](docs/data-issues.md). The guiding rule: source notes can only make hours stricter, never looser.

- 33 places list no hours: 17 public spaces are treated as open 07:00 to 23:00, 5 get a window from their name ("by Night", "at Dawn"), and 11 stay unknown, plannable with a warning.
- 5 have free-text hours ("Evenings", "Morning only") turned into estimated windows.
- 8 are open only in some months or on some days (six seasonal notes, a weekday-only tour, a third-weekend market) and are never planned outside them; 3 notes that would extend hours are shown but not applied.
- 1 place listed about 156 km from its city is moved to the middle of its neighborhood and marked approximate.
- 9 visit lengths are missing and take a typical length for their type; 1 is shortened to fit its type and its opening hours.
- 5 restaurants can only serve one of lunch or dinner given their hours.
- 6 places share a spot or an experience with another listing, and a trip includes at most one of each pair.

## AI and guardrails

| Guardrail | Where |
|---|---|
| Clean, typed data before the model sees it | `packages/planner/src/normalize` |
| A shortlist of places open on the dates, enforced after the answer | `services/api/src/plan/candidates.ts`, `plan/materialize.ts` |
| Structured outputs, ids only, parsed with Zod | `services/api/src/llm/anthropic.ts`, `llm/schema.ts` |
| Every time and travel leg computed in code, then an independent validator | `packages/planner/src/schedule.ts`, `validate.ts` |
| Tidying of what the model cannot see, labelled "fixed after a check" | `services/api/src/plan/tidy.ts`, `packages/planner/src/orderDay.ts` |
| One repair turn with the exact violations | `services/api/src/plan/planTrip.ts`, `llm/prompt.ts` |
| One day planned again from the places no other day has, the other days never changed, the whole trip validated; a route of a city a day planned a day at a time, judged first by the rules | `services/api/src/plan/replanDay.ts`, `plan/dayShortlist.ts`, `packages/planner/src/dayBases.ts`, `dayRoute.ts` |
| Rules-only plan for every other outcome, and a final guard on every response | `services/api/src/plan/outcome.ts` |
| Traveler notes escaped as data, reasons and summary sanitized | `llm/prompt.ts`, `plan/reasons.ts`, `plan/summary.ts`, `plan/textGuards.ts` |
| 24 s deadline, 15 s per call, 29 s function timeout under API Gateway's 30 s | `plan/planTrip.ts`, `infra/sam/template.yaml` |
| Cost limits: WAF per-IP limits, gateway throttles, 10 reserved instances, per-client limit, a plan cache in the tab, the instance and the table | `infra/terraform/platform/waf.tf`, `infra/sam/template.yaml`, `services/api/src/lib`, `services/api/src/plan/planCache.ts`, `apps/web/lib/planMemo.ts` |
| The browser re-validates every API plan and every edit | `apps/web/lib/planRequest.ts`, `apps/web/lib/itineraryReducer.ts` |
| A saved trip's why lines and summary come only from the API's records of the AI plan, checked again when saved; the save takes ids only | `services/api/src/routes/trips.ts`, `trips/rebuild.ts` |
| A saved trip of a plan made with notes keeps none of the AI's text (no summary, rule why lines on every stop), and Copy link says so | `packages/planner/src/privateText.ts`, `services/api/src/trips/records.ts` |

The default model is `claude-sonnet-5`, with `claude-haiku-4-5-20251001` as the faster comparison.

## Evals

Sixteen cases on real places, each with what a good plan must show: interests matched, nothing on a closed day, must-includes placed, and a summary that says what was not possible. `pnpm eval --model <id> --runs <n>` records live answers (it needs `ANTHROPIC_API_KEY` and spends money). `pnpm eval:replay` replays every recording through the current code with no network and rewrites [latest.md](packages/evals/results/latest.md). CI runs the replay on every push, with 12 hand-written bad answers (a refusal, a timeout, injected notes, places outside the data) that must each end in a valid plan by the path they name. The live eval workflow runs only when started by hand. Results are at the top of this page.

## Project layout

| Path | Contents |
|---|---|
| `apps/web` | Next.js app, exported as static files, installable as a PWA |
| `services/api` | Hono API, run locally on Node and in production on AWS Lambda |
| `packages/planner` | Data normalization, travel model, scheduler, validator and rules-only planner in plain TypeScript, shared by the API and the web app |
| `packages/evals` | Evaluation runs for the AI planner |
| `e2e` | Playwright tests across phone, tablet and desktop profiles |
| `infra` | Terraform (`bootstrap`, `platform`), the SAM template, and infra tests |
| `data/italy.json` | Source data, never edited |
| `docs` | Architecture, decisions, testing, deploy guide, data reports |

## Deploy

AWS (CloudFront, S3, WAF, API Gateway, Lambda) with Terraform and SAM. An admin made the first deploy by hand; after that, each push to `main` that passes CI is deployed by GitHub Actions. See [docs/deploy.md](docs/deploy.md).

## Decisions

The reasoning behind the main choices, with the alternatives considered: [docs/decisions.md](docs/decisions.md).
