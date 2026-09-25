# 3 Days in Italy

A trip planner that turns a list of 103 places in Italy into a three-day itinerary with times that respect opening hours, meals, and travel.

- Web app: https://italy-planner.brdjx.com
- Public API: https://api.italy-planner.brdjx.com (for example `/health`, `/places`, `POST /plan`; see [docs/deploy.md](docs/deploy.md#why-two-hostnames))

## Quickstart

Requires Node 24 and pnpm 12 (`corepack enable` sets it up).

```sh
pnpm install && pnpm dev
```

Open http://localhost:3000. The API runs at http://localhost:8787 (try `/api/health`).

No API key is needed. Without one, every trip comes from the rules-only planner and the page says so. To turn on the AI planner locally, copy `.env.example` to `.env` at the repository root and set `ANTHROPIC_API_KEY`. The local API listens on 127.0.0.1 only.

| Command | What it does |
|---|---|
| `pnpm dev` | API on port 8787 and web on port 3000 |
| `pnpm build` | Static web export (`apps/web/out`) and Lambda bundle (`services/api/dist`) |
| `pnpm check` | Lint, typecheck, unit and integration tests |
| `pnpm test:e2e` | Playwright end to end (builds the app, starts the API with scripted model answers) |
| `pnpm data:audit` | Regenerates `docs/data-issues.md` from the normalizer |

## What it does

- Plans three days from a start date, a pace, interests, a budget, bases to stay in, places to include and places to skip. Each stop gets a time, the travel from the previous stop, and a reason.
- Checks every plan against opening hours on the actual dates, meal windows, travel time and the day's pace, and shows what the data could not confirm (estimated hours, approximate locations, seasonal closures).
- Lets the traveler swap, remove, reorder and undo stops, re-checks each edit in the browser, and shares a plan as a link. It installs as an app and still plans offline.

## How planning works

```
TripRequest (checked with Zod)
  -> shortlist: up to 4 bases, and per base the best visits and meal places for the dates
  -> Claude selects: a base per day and ordered place ids, with a reason per stop (ids only)
  -> parse with Zod -> tidy what the model cannot see (closed days, repeats, the visit limit,
     an order the scheduler cannot time, visits the hours cannot hold) -> ids outside the
     shortlist are errors
  -> scheduler assigns every time -> independent validator
       no errors, nothing tidied    -> source "ai"
       no errors, tidied            -> source "ai_repaired"
       errors                       -> one repair turn with the exact violations left
                                       -> tidied and validated again -> source "ai_repaired"
       still invalid, timeout,
       refusal, API error, no key   -> rules-only planner -> source "deterministic"
  -> response: itinerary, warnings, source, meta (fallback reason, attempts, latency)
```

The model proposes and code decides. Claude only chooses and orders place ids from a shortlist the code built; it never writes a time, a travel estimate or an opening hour. The scheduler times the chosen ids with the same rules the rules-only planner uses, and a validator that never calls the scheduler checks the result. Before the check, code tidies what the model cannot see because code assigns the times: it drops a place on its closed day, a repeat, and visits over the pace's limit, reorders a day the scheduler cannot time, and drops the latest visits a day's hours still cannot hold, keeping the model's bases, its must-includes and the day's meals. A plan with any error never reaches the traveler: the model gets one chance to fix what is left, and every other outcome falls back to the rules-only plan, which the page labels. The same planner package runs in the browser, so edits and share links are checked with the same rules, and the page plans on the device when the API cannot answer. More in [docs/architecture.md](docs/architecture.md); the planner's rules, and what each one buys, are in [docs/planner.md](docs/planner.md).

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
| Rules-only plan for every other outcome, and a final guard on every response | `services/api/src/plan/outcome.ts` |
| Traveler notes escaped as data, reasons and summary sanitized | `llm/prompt.ts`, `plan/reasons.ts`, `plan/summary.ts`, `plan/textGuards.ts` |
| 24 s deadline, 12 s per call, 29 s function timeout under API Gateway's 30 s | `plan/planTrip.ts`, `infra/sam/template.yaml` |
| Cost limits: WAF per-IP limits, gateway throttles, 10 reserved instances, per-client limit, cache | `infra/terraform/platform/waf.tf`, `infra/sam/template.yaml`, `services/api/src/lib` |
| The browser re-validates every API plan and every edit | `apps/web/lib/planRequest.ts`, `apps/web/lib/itineraryReducer.ts` |

The default model is `claude-sonnet-5`, with `claude-haiku-4-5-20251001` as the faster comparison.

## Evals

Eval results: see packages/evals/results/latest.md

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

## Testing

```sh
pnpm check           # lint, typecheck, unit and integration tests
pnpm test:coverage   # the same tests with per-area coverage floors
pnpm test:props      # planner property tests at 5,000 runs
pnpm test:e2e        # Playwright on six device profiles plus the installed app
```

Tests are organized by what would break the product (an invalid plan, a hung model call, a leaked secret, runaway cost, a bad deploy), each with the guard in code and the tests that prove it. See [docs/testing.md](docs/testing.md).

## Deploy

AWS (CloudFront, S3, WAF, API Gateway, Lambda) with Terraform and SAM. An admin made the first deploy by hand; after that, each push to `main` that passes CI is deployed by GitHub Actions. See [docs/deploy.md](docs/deploy.md).

## Decisions

The reasoning behind the main choices, with the alternatives considered: [docs/decisions.md](docs/decisions.md).
