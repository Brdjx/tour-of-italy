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
| T05 | Profile script writing `docs/data-profile.md` | todo | |
| T06 | Shared type contract (`types.ts`) and tunable constants (`config.ts`) | todo | |
| T07 | Normalizers: hours, seasons, duration, price, rating, geo, names, tags, ids | todo | |
| T08 | `time.ts`: one source of truth for "is this place open on this date" | todo | |
| T09 | Audit script writing `docs/data-issues.md` | todo | |
| T10 | Independent record-by-record check of all 103 places | todo | |
| T11 | Data test hardening: fuzzing, corrupted datasets, checksum, time zone matrix | todo | |

## Phase 2: planner core

| Id | Task | Status | Evidence |
|---|---|---|---|
| T12 | Travel model (walk, local, regional, intercity rail) and bases with day trips | todo | |
| T13 | Scoring and constraints | todo | |
| T14 | Scheduler: `scheduleDay` and `planDeterministic` | todo | |
| T15 | Validator, written independently of the scheduler | todo | |
| T16 | Swap alternatives | todo | |
| T17 | Property tests and validator mutation tests | todo | |

## Phase 3: API and AI layer

| Id | Task | Status | Evidence |
|---|---|---|---|
| T18 | Hono routes: health, meta, places, data issues, plan | todo | |
| T19 | Claude client: structured outputs, per-model settings, fixture client | todo | |
| T20 | Plan orchestration: shortlist, select, validate, repair, fallback | todo | |
| T21 | Reason sanitizing and rule-based reasons | todo | |
| T22 | Logging, request ids, cache, rate limit, origin check, error handling | todo | |
| T23 | Failure-injection integration tests (timeouts, errors, injection, leaks, abuse) | todo | |

## Phase 4: web app

| Id | Task | Status | Evidence |
|---|---|---|---|
| T24 | Trip form, timetable, source badge, warning chips, data notes panel | todo | |
| T25 | Edits validated in the browser: swap, remove, reorder, undo | todo | |
| T26 | Shareable plan links | todo | |
| T27 | Day map | todo | |
| T28 | PWA: manifest, icons, service worker, update prompt, offline planning | todo | |
| T29 | Safe areas and responsive layouts for iPhone, iPad, and Android | todo | |
| T30 | Component tests for every loading, error, and empty state | todo | |
| T31 | End-to-end tests on six device profiles, accessibility scan, PWA checks | todo | |

## Phase 5: infrastructure

| Id | Task | Status | Evidence |
|---|---|---|---|
| T32 | Terraform bootstrap: deploy and plan roles, permissions boundary, artifacts bucket, budget | todo | |
| T33 | Terraform platform: certificate, DNS, web bucket, CloudFront, WAF, origin secret | todo | |
| T34 | SAM: Lambda, HTTP API, log groups, alarms | todo | |
| T35 | Infrastructure tests and security scan | todo | |
| T36 | Allow the service worker and manifest in the content security policy | todo | |
| T37 | Deploy runbook in `docs/deploy.md` | todo | |

## Phase 6: CI/CD

| Id | Task | Status | Evidence |
|---|---|---|---|
| T38 | CI: verify, infrastructure checks, secret scan, Terraform plan on pull requests | review | actionlint and zizmor clean; not yet run on GitHub |
| T39 | Deploy workflow with post-deploy smoke checks | review | actionlint and zizmor clean; not yet run on GitHub |
| T40 | Eval workflow | review | actionlint clean; not yet run on GitHub |
| T41 | Dependabot, code owners, pull request template, actions pinned to commit hashes | review | every action pinned to a verified commit hash |

## Deploy

| Id | Task | Status | Evidence |
|---|---|---|---|
| T42 | Store the Anthropic key in SSM and as a GitHub secret without echoing it | todo | |
| T43 | Apply bootstrap, configure the GitHub environment and variables | todo | |
| T44 | First deploy: SAM, then platform, then web, then smoke checks | todo | |
| T45 | Push to GitHub, confirm CI passes and the deploy runs from `main` | todo | |
| T46 | Production smoke checks, including the browser smoke test | todo | |

## Phase 7: evals

| Id | Task | Status | Evidence |
|---|---|---|---|
| T47 | Fifteen eval cases using real place ids | todo | |
| T48 | Live eval runner with recordings, replayed in CI without network | todo | |
| T49 | Compare Sonnet 5, Haiku 4.5, and the rules-only baseline | todo | |

## Phase 8: docs

| Id | Task | Status | Evidence |
|---|---|---|---|
| T50 | README, write-up with real numbers, decisions log, AI usage log, testing strategy | todo | |

## Phase 9: final pass

| Id | Task | Status | Evidence |
|---|---|---|---|
| T51 | Test audit repeated until two rounds find nothing new | todo | |
| T52 | Final review: security, correctness, accessibility, prose, secrets in history | todo | |
| T53 | Fresh clone check, tag `v1.0.0` | todo | |

## Cut or deferred

| Id | Task | Status | Reason |
|---|---|---|---|
