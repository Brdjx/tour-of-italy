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
| T01 | Ignore the private brief folder and local secrets | done | 763bf6b |
| T02 | Add the dataset at `data/italy.json` and record its checksum | done | sha256 e81d04d7...938a |
| T03 | pnpm monorepo: workspace, TypeScript, Biome, Vitest, health route, web shell | done | pnpm check green (15 tests), dev servers verified |
| T04 | Pin the toolchain (TypeScript 7 compatibility, Lambda Node runtime) | done | TypeScript 7.0.2 works with Next 16 and Vitest 5; Lambda nodejs24.x |

## Phase 1: data profiling and normalization

| Id | Task | Status | Evidence |
|---|---|---|---|
| T05 | Profile script writing `docs/data-profile.md` | done | 9c68af4 |
| T06 | Shared type contract (`types.ts`) and tunable constants (`config.ts`) | done | 9c68af4 |
| T07 | Normalizers: hours, seasons, duration, price, rating, geo, names, tags, ids | done | 9c68af4 |
| T08 | `time.ts`: one source of truth for "is this place open on this date" | done | 9c68af4 |
| T09 | Audit script writing `docs/data-issues.md` | done | 9c68af4; 112 issues across 23 kinds |
| T10 | Independent record-by-record check of all 103 places | done | record-by-record review found 0 mismatches |
| T11 | Data test hardening: fuzzing, corrupted datasets, checksum, time zone matrix | done | 9c68af4; fuzzing, corrupted datasets, checksum, TZ guard |

## Phase 2: planner core

| Id | Task | Status | Evidence |
|---|---|---|---|
| T12 | Travel model (walk, local, regional, intercity rail) and bases with day trips | done | 9e811c7 |
| T13 | Scoring and constraints | done | 9e811c7 |
| T14 | Scheduler: `scheduleDay` and `planDeterministic` | done | 9e811c7; three realism review rounds |
| T15 | Validator, written independently of the scheduler | done | 2a3d349 |
| T16 | Swap alternatives | done | 9e811c7 |
| T17 | Property tests and validator mutation tests | done | 0337281; 5000-run property tests green |

## Phase 3: API and AI layer

| Id | Task | Status | Evidence |
|---|---|---|---|
| T18 | Hono routes: health, meta, places, data issues, plan | done | 8488601 |
| T19 | Claude client: structured outputs, per-model settings, fixture client | done | 8488601; live call blocked by key scope, see T58 |
| T20 | Plan orchestration: shortlist, select, validate, repair, fallback | done | 8488601 |
| T21 | Reason sanitizing and rule-based reasons | done | 8488601 |
| T22 | Logging, request ids, cache, rate limit, origin check, error handling | done | 8488601 |
| T23 | Failure-injection integration tests (timeouts, errors, injection, leaks, abuse) | done | 8488601; 301+ API tests |

## Phase 4: web app

| Id | Task | Status | Evidence |
|---|---|---|---|
| T24 | Trip form, timetable, source badge, warning chips, data notes panel | done | 5adb40a |
| T25 | Edits validated in the browser: swap, remove, reorder, undo | done | 5adb40a |
| T26 | Shareable plan links | done | 5adb40a |
| T27 | Day map | done | 5adb40a |
| T28 | PWA: manifest, icons, service worker, update prompt, offline planning | done | 7a2b742 |
| T29 | Safe areas and responsive layouts for iPhone, iPad, and Android | done | 5adb40a |
| T30 | Component tests for every loading, error, and empty state | done | 5adb40a |
| T31 | End-to-end tests on six device profiles, accessibility scan, PWA checks | done | 0572d6a; 286 E2E tests, 0 retries |

## Phase 5: infrastructure

| Id | Task | Status | Evidence |
|---|---|---|---|
| T32 | Terraform bootstrap: deploy and plan roles, permissions boundary, artifacts bucket, budget | done | 329784b; 22 bootstrap + 12 platform Terraform tests |
| T33 | Terraform platform: certificate, DNS, web bucket, CloudFront, WAF, origin secret | done | 329784b |
| T34 | SAM: Lambda, HTTP API, log groups, alarms | done | 329784b; SAM lint clean, 31 template assertions |
| T35 | Infrastructure tests and security scan | done | 329784b; terraform test, tflint, trivy in CI |
| T36 | Allow the service worker and manifest in the content security policy | done | 329784b; CSP allows worker-src and manifest-src self |
| T37 | Deploy runbook in `docs/deploy.md` | done | 329784b |

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
| T43 | Apply bootstrap, configure the GitHub environment and variables | done | bootstrap applied, six ids pinned (e338017), role variables set |
| T44 | First deploy: SAM, then platform, then web, then smoke checks | done | 147e285 deployed by hand; smoke test all green on both hosts |
| T45 | Push to GitHub, confirm CI passes and the deploy runs from `main` | done | c911df2 deployed automatically from main |
| T46 | Production smoke checks, including the browser smoke test | done | post-deploy smoke.sh and Playwright smoke against production green |

## Phase 7: evals

| Id | Task | Status | Evidence |
|---|---|---|---|
| T47 | Fifteen eval cases using real place ids | done | 3ae21f4; 15 cases on real places |
| T48 | Live eval runner with recordings, replayed in CI without network | done | 3ae21f4; replay 100% final valid, 11/11 guardrail recordings |
| T49 | Compare Sonnet 5, Haiku 4.5, and the rules-only baseline | todo | |

## Phase 8: docs

| Id | Task | Status | Evidence |
|---|---|---|---|
| T50 | README, write-up with real numbers, decisions log, AI usage log, testing strategy | in progress | README, architecture, decisions, testing done (53314d7); write-up waits for live eval numbers |

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
| T58 | Use a workspace-scoped Anthropic key (the current key needs the anthropic-workspace-id header) | in progress | new key in .env.anthropic answers without the header; SSM and the GitHub secret still hold the old key, waiting for the owner's go-ahead |
| T59 | Measure each planner heuristic by ablation and remove the ones that do not earn their keep | done | a577b1d; 25 rules removed, 7 files merged, judged on 3 seeds |
| T60 | Simpler default view: filters behind More options, collapsed trip summary after planning | done | 2e01dec; one column on every screen, unit tests green |
| T61 | Loading skeletons before search (meta, places, map) and after search (timetable while planning) | done | 2e01dec; PlannerApp.skeleton and planArrival tests |
| T62 | Rewrite the E2E specs for the new page and make E2E a blocking check again | todo | E2E reports but does not block CI since the redesign started (owner's call) |
| T63 | TikTok Sans with every axis, with a metric-matched fallback | done | aa90e7f |
| T64 | Impeccable design skill and PRODUCT.md | done | d6aff24 |
| T65 | Redesign: the departure board in the Goodpix language (tokens, type, board, motion) | in progress | direction contract in apps/web/.impeccable/surfaces/ |
| T66 | Real place photos from Wikimedia Commons, credited, with city and topic fallbacks | in progress | 74 of 103 places verified, 26 fallbacks |
| T67 | Self-hosted vector map (MapLibre, Protomaps tiles on the site's own CloudFront) | in progress | owner chose it over Google Maps |
| T68 | Live AI path: Sonnet 5 exceeds the 24 s limit on the real request; Haiku 4.5 fails validation twice | todo | live-smoke 2026-09-24: both fall back to rules |

## Cut or deferred

| Id | Task | Status | Reason |
|---|---|---|---|
