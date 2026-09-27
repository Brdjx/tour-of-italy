# Task log

Every piece of work has a stable id. Ids never change or get reused; new work takes the next number.
Until 25 September, commits referenced their task with a `Refs: T12` trailer, so `git log --grep "T12"`
shows the history of those tasks. The work after tag `v1.0.0` (a day planned again, the route sheet, the
missing meals, the E2E gate) has no task ids; it is recorded as decisions 15 to 17 in `decisions.md` and
in `testing.md`.

The commit ids here refer to the private repository: the submission zip holds the tagged tree only,
without its git history, which is available on request.

Statuses:

- `todo`: agreed, not started
- `in progress`: being built now
- `review`: built, under independent review or verification
- `done`: merged, with the evidence listed
- `blocked`: waiting on something outside the task (the note says what)
- `cut`: deliberately not done, with the reason (scope judgment is part of the record)
- `deferred`: not done for this submission and kept for later, with the reason

## Phase 0: scaffold

| Id | Task | Status | Evidence |
|---|---|---|---|
| T01 | Ignore the private brief folder and local secrets | done | 8f6008f |
| T02 | Add the dataset at `data/italy.json` and record its checksum | done | sha256 e81d04d7...938a |
| T03 | pnpm monorepo: workspace, TypeScript, Biome, Vitest, health route, web shell | done | pnpm check green (15 tests), dev servers verified |
| T04 | Pin the toolchain (TypeScript 7 compatibility, Lambda Node runtime) | done | TypeScript 7.0.2 works with Next 16 and Vitest 5; Lambda nodejs24.x |

## Phase 1: data profiling and normalization

| Id | Task | Status | Evidence |
|---|---|---|---|
| T05 | Profile script writing `docs/data-profile.md` | done | 6a030ad |
| T06 | Shared type contract (`types.ts`) and tunable constants (`config.ts`) | done | 6a030ad |
| T07 | Normalizers: hours, seasons, duration, price, rating, geo, names, tags, ids | done | 6a030ad |
| T08 | `time.ts`: one source of truth for "is this place open on this date" | done | 6a030ad |
| T09 | Audit script writing `docs/data-issues.md` | done | 6a030ad; 112 issues across 23 kinds |
| T10 | Independent record-by-record check of all 103 places | done | record-by-record review found 0 mismatches |
| T11 | Data test hardening: fuzzing, corrupted datasets, checksum, time zone matrix | done | 6a030ad; fuzzing, corrupted datasets, checksum, TZ guard |

## Phase 2: planner core

| Id | Task | Status | Evidence |
|---|---|---|---|
| T12 | Travel model (walk, local, regional, intercity rail) and bases with day trips | done | 63a2acd |
| T13 | Scoring and constraints | done | 63a2acd |
| T14 | Scheduler: `scheduleDay` and `planDeterministic` | done | 63a2acd; three realism review rounds |
| T15 | Validator, written independently of the scheduler | done | a10684f |
| T16 | Swap alternatives | done | 63a2acd |
| T17 | Property tests and validator mutation tests | done | 0947974; 5000-run property tests green |

## Phase 3: API and AI layer

| Id | Task | Status | Evidence |
|---|---|---|---|
| T18 | Hono routes: health, meta, places, data issues, plan | done | 3e49bf2 |
| T19 | Claude client: structured outputs, per-model settings, fixture client | done | 3e49bf2; the first live call waited on a workspace-scoped key (T58, done) |
| T20 | Plan orchestration: shortlist, select, validate, repair, fallback | done | 3e49bf2 |
| T21 | Reason sanitizing and rule-based reasons | done | 3e49bf2 |
| T22 | Logging, request ids, cache, rate limit, origin check, error handling | done | 3e49bf2 |
| T23 | Failure-injection integration tests (timeouts, errors, injection, leaks, abuse) | done | 3e49bf2; 301+ API tests |

## Phase 4: web app

| Id | Task | Status | Evidence |
|---|---|---|---|
| T24 | Trip form, timetable, source badge, warning chips, data notes panel | done | 13c1fd3 |
| T25 | Edits validated in the browser: swap, remove, reorder, undo | done | 13c1fd3 |
| T26 | Shareable plan links | done | 13c1fd3 |
| T27 | Day map | done | 13c1fd3 |
| T28 | PWA: manifest, icons, service worker, update prompt, offline planning | done | 89f435f |
| T29 | Safe areas and responsive layouts for iPhone, iPad, and Android | done | 13c1fd3 |
| T30 | Component tests for every loading, error, and empty state | done | 13c1fd3 |
| T31 | End-to-end tests on six device profiles, accessibility scan, PWA checks | done | a856d20; 286 E2E tests, 0 retries |

## Phase 5: infrastructure

| Id | Task | Status | Evidence |
|---|---|---|---|
| T32 | Terraform bootstrap: deploy and plan roles, permissions boundary, artifacts bucket, budget | done | 17a2aea; 22 bootstrap + 12 platform Terraform tests |
| T33 | Terraform platform: certificate, DNS, web bucket, CloudFront, WAF, origin secret | done | 17a2aea |
| T34 | SAM: Lambda, HTTP API, log groups, alarms | done | 17a2aea; SAM lint clean, 31 template assertions |
| T35 | Infrastructure tests and security scan | done | 17a2aea; terraform test, tflint, trivy in CI |
| T36 | Allow the service worker and manifest in the content security policy | done | 17a2aea; CSP allows worker-src and manifest-src self |
| T37 | Deploy runbook in `docs/deploy.md` | done | 17a2aea |

## Phase 6: CI/CD

| Id | Task | Status | Evidence |
|---|---|---|---|
| T38 | CI: verify, infrastructure checks, secret scan, Terraform plan on pull requests | done | ci.yml green on GitHub (9 jobs incl. WebKit E2E and gitleaks); E2E moved to its own workflow in 6038aa2 |
| T39 | Deploy workflow with post-deploy smoke checks | done | deploy run 36003028360: gate, build, OIDC deploy, prod smoke all green |
| T40 | Eval workflow | review | actionlint clean; started by hand only since 22f798e (T81); not yet run on GitHub, the live runs so far are local (T49) |
| T41 | Dependabot, code owners, pull request template, actions pinned to commit hashes | review | every action pinned to a verified commit hash |

## Deploy

| Id | Task | Status | Evidence |
|---|---|---|---|
| T42 | Store the Anthropic key in SSM and as a GitHub secret without echoing it | done | SSM SecureString v1 (aws/ssm key) and repo secret set from file, never echoed |
| T43 | Apply bootstrap, configure the GitHub environment and variables | done | bootstrap applied, six ids pinned (577adc7), role variables set |
| T44 | First deploy: SAM, then platform, then web, then smoke checks | done | b080eac deployed by hand; smoke test all green on both hosts |
| T45 | Push to GitHub, confirm CI passes and the deploy runs from `main` | done | f81dc9f deployed automatically from main |
| T46 | Production smoke checks, including the browser smoke test | done | post-deploy smoke.sh and Playwright smoke against production green |

## Phase 7: evals

| Id | Task | Status | Evidence |
|---|---|---|---|
| T47 | Sixteen eval cases using real place ids | done | 504ec03 with 15 cases; 6ccaa8c added rome-sunday-balanced, the owner's failed request |
| T48 | Live eval runner with recordings, replayed in CI without network | done | 504ec03; replay 100% final valid; 12/12 guardrail recordings end as named (the 12th from 6ccaa8c) |
| T49 | Compare Sonnet 5, Haiku 4.5, and the rules-only baseline | done | 0219a78, a03235d: 48 Sonnet 5 and 32 Haiku 4.5 live plans on 16 cases, all final valid; valid after tidying 100% and 72%, fallbacks 0 and 2, days missing a meal 26% and 72% (rules-only 19%); about $1.60 |

## Phase 8: docs

| Id | Task | Status | Evidence |
|---|---|---|---|
| T50 | README, write-up with real numbers, decisions log, AI usage log, testing strategy | done | architecture, decisions, testing from ac3e79f; README results table and quickstart from 329246f; AI usage log written in 82f3788; `WRITEUP.md` from 4320c8d; all in every tag from `v1.0.0` to `v1.3.1` |

## Phase 9: final pass

| Id | Task | Status | Evidence |
|---|---|---|---|
| T51 | Test audit repeated until two rounds find nothing new | todo | No test audit rounds are recorded in the history or the docs. |
| T52 | Final review: security, correctness, accessibility, prose, secrets in history | todo | Done so far: design and code reviews of the route sheet (82c3e31) and a review of decision 17 (402f2ec), with their fixes; axe and layout audits of the states a traveler reaches, on every device project in light and dark (`e2e/tests/audit.spec.ts`); gitleaks over the full history in CI's `secrets` job, green on the commit of every tag; a review of `v1.3.1` and the live site on 2026-09-26, whose findings (legs in Venice said "by taxi or bus", meal sentences that read as claims about a city, docs that assumed the git history) are fixed after that tag. No security or prose review of the whole submission is recorded. |
| T53 | Fresh clone check, tag `v1.0.0` | todo | Tagged: `v1.0.0` (a22de43, 2026-09-25), `v1.1.0` (48994fd), `v1.2.0` (8149d55), `v1.3.0` (9f5d02a) and `v1.3.1` (3582343, 2026-09-26), each on a commit whose CI passed. No check from a fresh copy of a tagged tree (the zip, unpacked) is recorded; the quickstart's fixture mode was checked on 329246f. |
| T54 | Pre-publication scan: full history for secrets and private material, personal details out of committed defaults | todo | Done: gitleaks scans the full history on every push, with one allowlist for AWS-shaped ids in `deployed-ids.auto.tfvars` only (8678aa4), green on every tag's commit; `docs/official-spec/` and `PLAN.md` are ignored and appear in no commit; comments cite committed docs, never the brief (T80). Not done: committed defaults still hold the owner's email address as the alarm and budget address (`infra/sam/samconfig.toml`, `infra/terraform/bootstrap/variables.tf`). |
| T57 | Rename the site to italy-planner.brdjx.com and add the public API host api.italy-planner.brdjx.com | done | live at italy-planner.brdjx.com and api.italy-planner.brdjx.com |
| T58 | Use a workspace-scoped Anthropic key (the current key needs the anthropic-workspace-id header) | done | 2026-09-24: SSM parameter version 2 and the GitHub secret hold the new key (digest checked, never printed) |
| T59 | Measure each planner heuristic by ablation and remove the ones that do not earn their keep | done | 8cb7665; 25 rules removed, 7 files merged, judged on 3 seeds |
| T60 | Simpler default view: filters behind More options, collapsed trip summary after planning | done | b43b600; one column on every screen, unit tests green |
| T61 | Loading skeletons before search (meta, places, map) and after search (timetable while planning) | done | b43b600; PlannerApp.skeleton and planArrival tests |
| T62 | Rewrite the E2E specs for the new page and make E2E a blocking check again | done | 7d46b6b, bfc652b and df27c6e: 62 failing tests fixed in the specs, none in the page; 312 of 312 passed in four full runs in a row; `e2e` is back in `ci.yml` with a 30 minute limit and in `ci-ok`'s needs |
| T63 | TikTok Sans with every axis, with a metric-matched fallback | done | 06ceace |
| T64 | Impeccable design skill and PRODUCT.md | done | da7098d |
| T65 | Redesign: the departure board in the Goodpix language (tokens, type, board, motion) | done | cb38379; tokens, type roles, board, motion, highlights, icon; contrast tests green in both schemes |
| T66 | Real place photos from Wikimedia Commons, credited, with city fallbacks | done | a706cb8; 73 places with their own photo, 8 city photos, 20 MB; credits link licence and source |
| T67 | Self-hosted vector map (MapLibre, Protomaps tiles on the site's own CloudFront) | done | 1189a1c; MapLibre with a 140 MB Protomaps extract uploaded to the site bucket once (docs/deploy.md) |
| T68 | Live AI path: Sonnet 5 exceeds the 24 s limit on the real request; Haiku 4.5 fails validation twice | done | 418afb3 turns Sonnet 5's thinking off for the plan request; cd1c501, 7c56ecb and ee1d258 tidy what the model cannot see. On the 90 recorded first answers of 2026-09-25, 85 pass the check after tidying (7 as written); a live plan on 2026-09-25 answered in 11.8 s as ai_repaired |
| T69 | Next design phase: no top navbar; the trip summary, Edit trip, Copy link and the planned with or without AI line share one compact row | done | d710fa4 and 09e53b9: the trip header replaces the bar; on phones Edit trip and Copy link are labelled pills in one row |
| T70 | Edit trip opens a full-screen overlay over a softly blurred page, with its own entrance and exit motion | done | d710fa4: Edit trip and More options are native dialog sheets over a blurred page (bottom sheets on phones, the page receding), with Start a new trip |
| T71 | About this data opens a full-screen overlay with far more detailed data | done | 26fc9e6: a tall sheet on phones and a 760px panel from 768px, with places by base and type, every kind of note, hours by source, summaries and all credits |
| T74 | Why lines that add information: rule lines say what the stop's date means for it; AI lines that contradict the stop as timed give way to the rule line, on the server and after every edit on the page | done | ea288f1, f97d2ca, de29c77; sweeps found no false or unprovable rule line and no false AI line after about 15,300 random edits |
| T75 | The default rules-only plan's first day can end without dinner (Rome, Fri 9 Oct 2026, balanced: a fifth visit takes the time) | done | 800d94c: a day still missing a meal gives up its least valuable visit for it; days missing a meal -1.5 points (mixed), -4.6 (must-includes) over three seeds |
| T76 | Live AI plans fell back when the model repeated places and emptied day 3 (owner's request, 2026-09-25 12:32 UTC) | done | 6ccaa8c: shortlist sized per trip, prompt v2, repair notes, tidy moves; live fallbacks 0 of 112 (8% before), slowest request 12 s |
| T77 | Copy link saves the exact trip (edits, AI why lines, summary, source) behind a short link, stored in DynamoDB | done | b2e6d65: `POST /api/trips` takes ids only and rebuilds the trip, one table with time to live, a `?t=` link (decision 12) |
| T78 | Tricolour band and animated flag; Edit trip disabled while planning; stop details and photos in a sheet | done | 78d6a2a; c4997c7 keeps the flag waving under a mouse |
| T79 | Cache AI plans by options across instances (DynamoDB) and in the tab | done | b2e6d65: the tab (20 plans), the instance (100) and the table (7 days), keyed on `planRequestKey` (decision 14) |
| T80 | Code comments cite committed docs, never the private brief | done | 4d8d5c5: 13 comments reworded, no behaviour change |
| T81 | The live eval workflow runs only when started by hand | done | 22f798e: the weekly schedule removed, `workflow_dispatch` kept |

## Cut or deferred

| Id | Task | Status | Reason |
|---|---|---|---|
| T55 | Make the repo public, require `ci-ok` on `main`, protect the `production` environment | cut | The submission is a zip of the tagged tree and the repository stays private. On GitHub Free a private repository has no branch protection or environment rules (`gh api repos/Brdjx/tour-of-italy/branches/main/protection` answers 403), so `ci-ok` is not required on `main` and the AWS trust policies are the guard ([deploy.md](deploy.md#github-plan)). |
| T56 | Tighten the deploy role trust to the `production` environment subject only | deferred | The deploy role accepts `...:environment:production` and `...:ref:refs/heads/main`, because GitHub may not honour environments in a private repository on GitHub Free; `ref`, `job_workflow_ref` and `actor_id` are the guards (decision in `infra/terraform/bootstrap/oidc.tf`). Revisit if the repository moves to GitHub Pro or goes public. |
| T72 | Richer colourways within the design language | cut | The page keeps ink and gold, with the flag's colours only on the tricolour band and mark (78d6a2a); more colourways did not fit before submission. |
| T73 | A detailed per-day skeleton for the itinerary on desktop, tablet and phone | deferred | The plan skeleton (`PlanSkeleton.tsx`, from T61, reshaped in cb38379 and d710fa4) already draws day tabs, the day heading, stop rows with times and the map in the plan's own layout on every screen; a separate design per device was not built. |
