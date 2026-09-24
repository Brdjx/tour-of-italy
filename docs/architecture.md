# Architecture

One page on how a request moves through the system, how a plan is made, where the code lives, how it is deployed, and what keeps it safe. Deploy steps are in [deploy.md](deploy.md), the reasons behind each choice in [decisions.md](decisions.md), and the tests in [testing.md](testing.md).

## Request path

```
Browser (Next.js static export, installable PWA)
  |  https://italy-planner.brdjx.com
  v
CloudFront site distribution
  WAF web ACL: plan calls per IP, all calls per IP, AWS managed rule groups
  Response headers policy: HSTS, CSP, nosniff, X-Frame-Options DENY, referrer policy
  |
  |-- /*      -> S3 web bucket (private, read only through origin access control)
  |
  '-- /api/*  -> adds x-origin-verify -> API Gateway HTTP API -> Lambda italy-planner-api (Hono)
                                                                  |-- @italy/planner
                                                                  |     places, scheduler,
                                                                  |     validator, rules-only planner
                                                                  '-- Claude API (Messages,
                                                                        structured outputs)

Deploy smoke test, curl and scripts, tool clients
  |  https://api.italy-planner.brdjx.com  (/health, /meta, /places, /data-issues, POST /plan)
  v
CloudFront API distribution (origin path /api; same WAF, headers policy and origin secret)
  '-> the same HTTP API and function
```

The browser only calls `/api/*` on its own host, so production needs no CORS. The evals use neither host: they import the production pipeline and run it in-process (`packages/evals/src/pipeline.ts`). The same `@italy/planner` package runs in the browser: the page re-validates every plan it receives and every edit, and plans on the device when the API cannot answer (`apps/web/lib/planRequest.ts`).

## Plan pipeline

```
POST /api/plan
  -> per-client limit (10 a minute per instance), JSON only (415), 16 KB byte cap (413)
  -> TripRequest parsed with Zod against the dataset's ids and bases (400 on any problem)
  -> ?mode=deterministic, AI switched off, or no key --------------------> rules-only plan
  -> rules-only plan made once (about 10 ms): the fallback, and a source of bases to offer
  -> shortlist: up to 4 bases; per base the best 12 visits and 5 meal places for the dates
  -> Claude selects: per day a base id and ordered place ids, a reason per stop, a summary
       structured outputs (JSON schema), ids only, no times
  -> stop_reason checked (refusal, max_tokens -> fallback), then parsed with Zod
  -> ids or bases outside the shortlist become errors
  -> scheduleTrip times the ids: travel, opening hours, meal windows, day window
  -> validateItinerary, the independent check
       no errors                  -> reasons and summary sanitized -> source "ai"
       errors, time left          -> one repair turn with the exact violations
                                     -> timed and validated again -> source "ai_repaired"
       still invalid, timeout,
       refusal, API error         -> rules-only plan, fallbackReason set -> "deterministic"
  -> final guard: zero validator errors and the response schema, else the rules-only plan
  -> response: itinerary, warnings (exactly the validator's), source, meta
```

Code: `services/api/src/routes/plan.ts` (the route), `services/api/src/plan/planTrip.ts` (the loop and the deadline), `plan/candidates.ts` (shortlist), `llm/anthropic.ts` and `llm/schema.ts` (the call and the parse), `plan/materialize.ts` (timing and validation), `plan/outcome.ts` (fallback and final guard). The whole request has a 24 s deadline counted from arrival, each model call at most 12 s, and 1.5 s is kept back for the fallback, so the function answers before API Gateway's 30 s cap. A model failure never becomes a 500. An infeasible request is a 422, and a rules-only plan that fails its own guard (a bug) is a 503, never an invalid plan.

## Monorepo layout

| Path | What it holds |
|---|---|
| `packages/planner` | Pure TypeScript, no I/O: data normalization, bases, travel, scoring, scheduler, validator, rules-only planner, alternatives. Runs in the Lambda and the browser. |
| `services/api` | Hono API. `app.ts` routes, `plan/` pipeline, `llm/` model client and fixtures, `lib/` logging, secrets, limits, caching. `local.ts` runs it on Node, `lambda.ts` on AWS Lambda. |
| `apps/web` | Next.js static export. `components/` UI, `lib/` API client, share links, stored plan, reducer; `public/sw.js` the hand-written service worker. |
| `packages/evals` | Eval cases, recorded model answers and the runner. `pnpm eval` records live answers; `pnpm eval:replay` replays every recording through the current pipeline offline and writes `results/latest.md`. |
| `e2e` | Playwright suites and `serve.mjs`, which serves the export and proxies `/api` the way CloudFront does. |
| `infra/terraform/bootstrap` | CI roles, permissions boundary, SAM artifacts bucket, budget. Applied by an admin. |
| `infra/terraform/platform` | Certificate, DNS, web bucket, both distributions, WAF, origin secret. |
| `infra/sam` | Lambda, HTTP API, log group, alarms. |
| `infra/test` | Vitest checks of the SAM template, host names, smoke script and workflow guards. |
| `data/italy.json` | The source data, never edited (a checksum test fails on any change). |
| `scripts` | `pnpm data:profile` and `pnpm data:audit`, which write `docs/data-profile.md` and `docs/data-issues.md`. |

## Deploy topology

| Layer | Contents | Applied by | State |
|---|---|---|---|
| Bootstrap | GitHub OIDC plan and deploy roles, `italy-planner-boundary`, artifacts bucket, budget | an admin, by hand | Terraform, `tour-of-italy/bootstrap.tfstate` |
| API | Lambda, HTTP API, log group, SNS topic, six alarms | an admin once, then CI | CloudFormation stack `italy-planner-api` |
| Platform | ACM certificate, Route 53 records, web bucket, site and API distributions, WAF, origin secret in SSM | an admin once, then CI | Terraform, `tour-of-italy/platform.tfstate` |

On a push to `main` that passes CI, `.github/workflows/deploy.yml` builds without credentials, then assumes the deploy role and runs `deploy-api.sh` (SAM), `apply-platform.sh` (Terraform), `publish-web.sh` (S3 and a CloudFront invalidation) and `smoke-test.sh`, followed by a Playwright smoke run in a job with no AWS credentials. The platform reads the SAM stack's output, so SAM goes first. CI updates these resources but cannot create or delete the HTTP API, the distributions, the origin access control, the headers policy or the certificate.

## Security model

- **Origin secret.** CloudFront adds `x-origin-verify` on both distributions. The function reads the value from SSM (cached 5 minutes, forced re-read on a mismatch at most every 10 s), compares SHA-256 digests in constant time, and answers 403 without it. An SSM failure fails closed. The direct execute-api URL therefore answers 403, which the post-deploy smoke test checks (`services/api/src/lib/originVerify.ts`, `infra/terraform/platform/secret.tf`).
- **WAF.** One web ACL on both hosts: 30 plan calls per IP per 5 minutes (any path spelling of `/api/plan` or `/plan`, decoded and normalized), 2000 requests per IP per 5 minutes overall, and the AWS IP reputation, known bad inputs and common rule sets (`infra/terraform/platform/waf.tf`).
- **Throttles and concurrency.** API Gateway allows `POST /api/plan` 1 request a second with a burst of 6 and other routes 50 a second with a burst of 100. The function has 10 reserved instances, which caps Claude spend and protects the other stacks in the account. Inside each instance a token bucket allows 10 plans a minute per client, keyed on `CloudFront-Viewer-Address` (IPv6 by /64), and an LRU cache of 100 AI plans answers repeats (`infra/sam/template.yaml`, `services/api/src/lib/rateLimit.ts`, `lib/cache.ts`).
- **IAM boundary and pinned ids.** Every role the deploy role creates must carry `italy-planner-boundary`, which only works for the `italy-planner-api` function's own code. The deploy role cannot change its own roles or policies and is denied the Anthropic key. Rights on resources AWS names with generated ids are scoped to the ids pinned in `infra/terraform/bootstrap/deployed-ids.auto.tfvars`. The trust policies accept only `deploy.yml` on `main` (deploy) or `ci.yml` on a pull request (plan), started by the owner's GitHub account.
- **No secrets in code.** The Anthropic key lives in an SSM SecureString created by hand and is read by the function at runtime (re-read every 15 minutes, and at once after a 401 or 403). The logger redacts registered secrets and key-shaped strings. Error bodies carry a fixed message and a request id, never a stack. gitleaks scans the full history on every CI run. Locally the key is optional and lives in a gitignored `.env`.
