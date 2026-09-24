# Task log

Every piece of work has a stable id. Ids never change or get reused; new work takes the next number.
Commits reference their task with a `Refs: T12` trailer, so `git log --grep "T12"` shows the history of
any task.

Statuses:

- `todo`: agreed, not started
- `in progress`: being built now
- `review`: built, under independent review or verification
- `done`: merged, with the evidence listed
- `blocked`: waiting on something outside the task (the note says what)
- `cut`: deliberately not done, with the reason (scope judgment is part of the record)

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
| T19 | Claude client: structured outputs, per-model settings, fixture client | done | 3e49bf2; live call blocked by key scope, see T58 |
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
| T38 | CI: verify, infrastructure checks, secret scan, Terraform plan on pull requests | done | ci.yml green on GitHub (9 jobs incl. WebKit E2E and gitleaks) |
| T39 | Deploy workflow with post-deploy smoke checks | done | deploy run 36003028360: gate, build, OIDC deploy, prod smoke all green |
| T40 | Eval workflow | review | actionlint clean; not yet run on GitHub |
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
| T47 | Fifteen eval cases using real place ids | done | 504ec03; 15 cases on real places |
| T48 | Live eval runner with recordings, replayed in CI without network | done | 504ec03; replay 100% final valid, 11/11 guardrail recordings |
| T49 | Compare Sonnet 5, Haiku 4.5, and the rules-only baseline | todo | |

## Phase 8: docs

| Id | Task | Status | Evidence |
|---|---|---|---|
| T50 | README, write-up with real numbers, decisions log, AI usage log, testing strategy | in progress | README, architecture, decisions, testing done (ac3e79f); write-up waits for live eval numbers |

## Phase 9: final pass

| Id | Task | Status | Evidence |
|---|---|---|---|
| T51 | Test audit repeated until two rounds find nothing new | todo | |
| T52 | Final review: security, correctness, accessibility, prose, secrets in history | todo | |
| T53 | Fresh clone check, tag `v1.0.0` | todo | |
| T54 | Pre-publication scan: full history for secrets and private material, personal details out of committed defaults | todo | |
| T55 | Make the repo public, require `ci-ok` on `main`, protect the `production` environment | todo | |
| T56 | Tighten the deploy role trust to the `production` environment subject only | todo | |
| T57 | Rename the site to italy-planner.brdjx.com and add the public API host api.italy-planner.brdjx.com | done | live at italy-planner.brdjx.com and api.italy-planner.brdjx.com |
| T58 | Use a workspace-scoped Anthropic key (the current key needs the anthropic-workspace-id header) | done | 2026-09-24: SSM parameter version 2 and the GitHub secret hold the new key (digest checked, never printed) |
| T59 | Measure each planner heuristic by ablation and remove the ones that do not earn their keep | done | 8cb7665; 25 rules removed, 7 files merged, judged on 3 seeds |
| T60 | Simpler default view: filters behind More options, collapsed trip summary after planning | done | b43b600; one column on every screen, unit tests green |
| T61 | Loading skeletons before search (meta, places, map) and after search (timetable while planning) | done | b43b600; PlannerApp.skeleton and planArrival tests |
| T62 | Rewrite the E2E specs for the new page and make E2E a blocking check again | todo | E2E reports but does not block CI since the redesign started (owner's call) |
| T63 | TikTok Sans with every axis, with a metric-matched fallback | done | 06ceace |
| T64 | Impeccable design skill and PRODUCT.md | done | da7098d |
| T65 | Redesign: the departure board in the Goodpix language (tokens, type, board, motion) | done | cb38379; tokens, type roles, board, motion, highlights, icon; contrast tests green in both schemes |
| T66 | Real place photos from Wikimedia Commons, credited, with city fallbacks | done | a706cb8; 73 places with their own photo, 8 city photos, 20 MB; credits link licence and source |
| T67 | Self-hosted vector map (MapLibre, Protomaps tiles on the site's own CloudFront) | done | 1189a1c; MapLibre with a 140 MB Protomaps extract uploaded to the site bucket once (docs/deploy.md) |
| T68 | Live AI path: Sonnet 5 exceeds the 24 s limit on the real request; Haiku 4.5 fails validation twice | todo | live-smoke 2026-09-24: both fall back to rules |
| T69 | Next design phase: no top navbar; the trip summary, Edit trip, Copy link and the planned with or without AI line share one compact row | todo | owner feedback 2026-09-24 |
| T70 | Edit trip opens a full-screen overlay over a softly blurred page, with its own entrance and exit motion | todo | owner feedback 2026-09-24 |
| T71 | About this data opens a full-screen overlay with far more detailed data | todo | owner feedback 2026-09-24 |
| T72 | Richer colourways within the design language | todo | owner feedback 2026-09-24 |
| T73 | A detailed per-day skeleton for the itinerary on desktop, tablet and phone | todo | owner feedback 2026-09-24 |

## Cut or deferred

| Id | Task | Status | Reason |
|---|---|---|---|
