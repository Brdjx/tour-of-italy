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
                                                                  |-- Claude API (Messages,
                                                                  |     structured outputs)
                                                                  '-- DynamoDB italy-planner-trips
                                                                        AI plan records, saved
                                                                        trips, cached AI plans

Deploy smoke test, curl and scripts, tool clients
  |  https://api.italy-planner.brdjx.com  (/health, /meta, /places, /data-issues, POST /plan,
  |                                         POST /trips, GET /trips/<id>)
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
  -> AI plan cache, keyed on the prompt, the model, the place data and the options: this
       instance's memory, then the table (at most 150 ms) --------------------> the same plan
  -> rules-only plan made once (about 10 ms): the fallback, and a source of bases to offer
  -> shortlist: up to 4 bases; per base the best visits and meal places for a whole trip
       there at the pace (each day's visits plus two, two meals a day plus one), none
       that cannot be a day's only stop on any trip date unless the traveler asked for it;
       under a budget, meal places one price level over it, marked, after those within it
  -> prompt: each base's meal supply (meal places that can take lunch and dinner each day,
       named on a scarce day), then its candidate rows
  -> Claude selects: per day a base id and ordered place ids, a reason per stop, a summary
       structured outputs (JSON schema), ids only, no times
  -> stop_reason checked (refusal, max_tokens -> fallback), then parsed with Zod
  -> tidy: drop places closed that day, repeats and second places at one spot, visits over
       the pace's limit; reorder a day the scheduler cannot time (bases and choices kept,
       and every must-include in the answer stays on one of its days); then drop the latest
       ordinary visit a day's hours cannot hold until it times cleanly (never a must-include
       or a meal the day needs), and put each back where the day's order holds it after all;
       a restaurant timed as a visit moves to where it is the meal the day lacks; a day
       repeats would empty keeps one of them, a day they would leave with meals only keeps
       one of its visits, and what a day cannot hold moves to another day at its base that
       holds it (the log keeps the rule that took it off its day)
  -> ids or bases outside the shortlist become errors
  -> scheduleTrip times the ids: travel, opening hours, meal windows, day window
  -> validateItinerary, the independent check
       no errors, nothing tidied  -> reasons and summary sanitized -> source "ai"
       no errors, tidied          -> source "ai_repaired", the log lists what was tidied
       errors, time left          -> one repair turn with the exact violations left, what
                                     tidying removed and why, and the free candidates for
                                     an empty day
                                     -> tidied, timed and validated again -> source "ai_repaired"
       still invalid, timeout,
       refusal, API error         -> rules-only plan, fallbackReason set -> "deterministic"
  -> final guard: zero validator errors and the response schema, else the rules-only plan
  -> AI plans only: their AI content kept 90 days under a new planId (at most 1 s; a store
       failure is logged and the plan goes out without one). With notes, the record keeps no
       summary and no why line (see Saved trips)
  -> AI plans only: cached in memory, and in the table for 7 days when the plan has a planId
       and the request no notes (at most 500 ms; a failure is logged, never an error)
  -> response: itinerary, warnings (exactly the validator's), source, meta, planId
```

Code: `services/api/src/routes/plan.ts` (the route), `plan/planCache.ts` (the cache), `services/api/src/plan/planTrip.ts` (the loop and the deadline), `plan/candidates.ts` (shortlist), `llm/anthropic.ts` and `llm/schema.ts` (the call and the parse), `plan/tidy.ts` (the tidy step), `plan/materialize.ts` (timing and validation), `plan/outcome.ts` (fallback and final guard). The whole request has a 24 s deadline counted from arrival, and 1.5 s is kept back for the fallback, so the function answers before API Gateway's 30 s cap. Each model call gets at most 15 s (`LLM_TIMEOUT_MS`) and never more than what is left of the deadline after the reserve: the first call gets the full 15 s, and a repair after a first answer at 15 s still gets 7.5 s. A model failure never becomes a 500. An infeasible request is a 422, and a rules-only plan that fails its own guard (a bug) is a 503, never an invalid plan.

## Plan cache

The same options are never sent to the model twice while a plan for them is kept. A plan is looked up in three places, nearest first:

| Layer | Where | Kept | Holds |
|---|---|---|---|
| The tab | `apps/web/lib/planMemo.ts`, in `usePlanTrip` | this tab until it closes or reloads, at most 20 plans | AI plans exactly as the API returned them, once this browser checked them; shown with the request as sent now |
| The instance | `services/api/src/lib/cache.ts`, an LRU in the function's memory | at most 100 plans, each only as long as its table item | AI plans with their planId, requests with notes included |
| The table | item `cache#<key>` in `italy-planner-trips` (`plan/planCache.ts`) | 7 days (`KEEP_SECONDS.cache`) | AI plans with a planId, requests without notes only |

The key is the planner's `planRequestKey` (`packages/planner/src/requestKey.ts`), so the page and the API agree on what "the same options" is: interests, must-includes and skips are sorted, the bases keep their order (the first is the planner's first choice), and the notes are kept as typed. The API's key is a SHA-256 of the prompt version, the model, the deployed commit, the place data's fingerprint and that key, so a new prompt, model, deploy or dataset never serves an old plan (a hit skips the planner, the validator and the text checks, so a deploy that changed them must not serve plans made before it). A table read has 150 ms, so a miss is never much slower than no cache; a failed read or write is logged (`cacheRead`, `cacheWrite`) and the plan goes on. Only AI plans are cached anywhere: a rules-only answer is usually a fallback that asking again may improve. A hit in any layer answers with the request as sent now (`{ ...cached, request }`), so the options show in the order just chosen; a rule why line that names interests keeps the order of the request it was made for. Edits never touch a cached plan, so planning options again shows the plan as it came. The log line says `cache: hit-memory`, `hit-store` or `miss`; a hit is not counted again in the AI plan metrics.

## Saved trips

```
Copy link (apps/web/components/ShareButton.tsx, lib/copyLink.ts)
  -> clipboard write starts inside the press, the link still a promise (Safari keeps the gesture)
  -> a plan with flagged stops is not sent: the ?p= link is copied, and the page says why
       ("a stop" or "stops", by how many are flagged)
  -> POST /api/trips { request (no notes), days: [{ anchorId, ids }], planId | tripId }
       gateway throttle 2 a second, burst 10; per-client limit (20 a minute per instance),
       JSON only, 16 KB cap
       strict Zod: known bases and places, at most 20 a day, 3 days; any other field is a 400
       AI content only from the store: plan#<planId>, or the saved trip it was opened from,
         used only when the request is the one the AI planned (fewer must-includes allowed)
       scheduleTrip times the ids, rule why lines on every stop
       stored AI why lines put back where the same place keeps its role on the same day:
         text checks again (checkAiReason), then the planner's claim check (attachReasons)
       stored summary cleaned for this trip's places (summaryForPlaces, the planner function
         the page shows the summary with, so sender and recipient read the same), then the
         text checks again
       validateItinerary: any error -> 422 trip_not_valid
       snapshot { itinerary, origin: { plannedBy, edited }, dataVersion, createdAt, expiresAt }
         written once under trip#<id>, id 10 base62 characters, a taken id tries another
  -> 201 { id } -> copies https://italy-planner.brdjx.com/?t=<id>; for a plan made with notes
       that had AI text the page also says the shared trip leaves out the AI's summary and why
       lines (privateAiText in the planner)
     any failure -> copies the ?p= link that rebuilds the trip from its places, and says so

Opening ?t=<id> (lib/useSavedTrip.ts, lib/savedTrip.ts)
  -> GET /api/trips/<id> (starts at once; the places load alongside)
       200: the snapshot exactly as stored, Cache-Control public, max-age=300, immutable
       404: unknown, malformed or expired id
  -> same data fingerprint as the loaded places -> shown as saved (origin "saved")
     different fingerprint -> timed again from its ids like a ?p= link, with a note
     404 -> "This saved trip could not be found." over the form
     network failure -> "Check the connection and open the link again.", ?t= kept for a reload
     a fetch that failed before the places arrived (the API was down, then Try again) is made
       once more when they do; until then the note over the form says the saved trip will open
       once the connection is back
  -> the traveler plans a trip of their own while a ?t= or ?p= link is still on its way: the
       link is given up (never opens, its parameter goes); the newer request wins
```

The traveler's notes are private. They are never stored, and when a plan was made with them its plan record keeps none of the AI's text, no summary and no why line, because the AI may have drawn any of it from the notes; every stop of the saved trip gets the rule's why line. The page checks the same with the same planner function (`privateAiText`) and, when the plan had AI text, says so when it copies the link.

The table (`TripsTable` in `infra/sam/template.yaml`) has one string key, `pk`, the record as JSON text in `body`, and `expiresAt` for its time to live: plan records 90 days (as long as the page keeps its last plan), saved trips a year, cached plans 7 days. A record may be written only while its key is free or its record has expired. It is retained on delete and replacement and has deletion protection on. The function may only GetItem and PutItem on it. Without `TRIPS_TABLE` the API uses an in-memory store outside production and none in production, where the trip routes answer 503 and the page copies the `?p=` link. The data fingerprint is the planner's `dataVersion` over the places `/api/places` serves; `/api/meta` reports it, and the page computes it over the places it loaded. Code: `services/api/src/routes/trips.ts`, `trips/rebuild.ts`, `trips/records.ts`, `trips/store.ts`, `trips/dynamoStore.ts`, `trips/keepPlan.ts`, `packages/planner/src/dataVersion.ts`.

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
| `infra/sam` | Lambda, HTTP API, trips table, log group, alarms. |
| `infra/test` | Vitest checks of the SAM template, host names, smoke script and workflow guards. |
| `data/italy.json` | The source data, never edited (a checksum test fails on any change). |
| `scripts` | `pnpm data:profile` and `pnpm data:audit`, which write `docs/data-profile.md` and `docs/data-issues.md`. |

## Deploy topology

| Layer | Contents | Applied by | State |
|---|---|---|---|
| Bootstrap | GitHub OIDC plan and deploy roles, `italy-planner-boundary`, artifacts bucket, budget | an admin, by hand | Terraform, `tour-of-italy/bootstrap.tfstate` |
| API | Lambda, HTTP API, trips table (retained on delete), log group, SNS topic, seven alarms | an admin once, then CI | CloudFormation stack `italy-planner-api` |
| Platform | ACM certificate, Route 53 records, web bucket, site and API distributions, WAF, origin secret in SSM | an admin once, then CI | Terraform, `tour-of-italy/platform.tfstate` |

On a push to `main` that passes CI, `.github/workflows/deploy.yml` builds without credentials, then assumes the deploy role and runs `deploy-api.sh` (SAM), `apply-platform.sh` (Terraform), `publish-web.sh` (S3 and a CloudFront invalidation) and `smoke-test.sh`, followed by a Playwright smoke run in a job with no AWS credentials. The platform reads the SAM stack's output, so SAM goes first. CI updates these resources but cannot create or delete the HTTP API, the distributions, the origin access control, the headers policy or the certificate.

## Security model

- **Origin secret.** CloudFront adds `x-origin-verify` on both distributions. The function reads the value from SSM (cached 5 minutes, forced re-read on a mismatch at most every 10 s), compares SHA-256 digests in constant time, and answers 403 without it. An SSM failure fails closed. The direct execute-api URL therefore answers 403, which the post-deploy smoke test checks (`services/api/src/lib/originVerify.ts`, `infra/terraform/platform/secret.tf`).
- **WAF.** One web ACL on both hosts: 30 plan calls per IP per 5 minutes (any path spelling of `/api/plan` or `/plan`, decoded and normalized), 2000 requests per IP per 5 minutes overall, and the AWS IP reputation, known bad inputs and common rule sets (`infra/terraform/platform/waf.tf`).
- **Throttles and concurrency.** API Gateway allows `POST /api/plan` 1 request a second with a burst of 6, `POST /api/trips` 2 a second with a burst of 10, and other routes (opening a saved trip included) 50 a second with a burst of 100. The function has 10 reserved instances, which caps Claude spend and protects the other stacks in the account. Inside each instance a token bucket allows 10 plans and 20 saves a minute per client, keyed on `CloudFront-Viewer-Address` (IPv6 by /64), and the plan cache answers repeats (`infra/sam/template.yaml`, `services/api/src/lib/rateLimit.ts`, `plan/planCache.ts`). The WAF has no rule of its own for `/api/trips` yet; only its overall per-IP limit applies (a follow-up, and the rule must match encoded spellings of the path too, since `POST /api/trip%73` reaches the handler; see [deploy.md](deploy.md)).
- **IAM boundary and pinned ids.** Every role the deploy role creates must carry `italy-planner-boundary`, which only works for the `italy-planner-api` function's own code. The deploy role cannot change its own roles or policies and is denied the Anthropic key. Rights on resources AWS names with generated ids are scoped to the ids pinned in `infra/terraform/bootstrap/deployed-ids.auto.tfvars`. The trust policies accept only `deploy.yml` on `main` (deploy) or `ci.yml` on a pull request (plan), started by the owner's GitHub account.
- **Saved trips carry no text from a link.** A saved trip's why lines and summary come from the API's own records of the AI plan, checked again when the trip is saved; the body that saves a trip is ids only and refuses anything else. Ids are 10 random base62 characters (about 8e17 of them), written once with a conditional put. Requests are stored without the traveler's notes, and AI text that may repeat them is left out (see Saved trips); a plan made with notes is cached in the function's memory only, never in the table. The function may only read one item and write new ones (`dynamodb:GetItem`, `dynamodb:PutItem`), inside the boundary and only from its own code; CI may manage the table but never read or write its items.
- **No secrets in code.** The Anthropic key lives in an SSM SecureString created by hand and is read by the function at runtime (re-read every 15 minutes, and at once after a 401 or 403). The logger redacts registered secrets and key-shaped strings. Error bodies carry a fixed message and a request id, never a stack. gitleaks scans the full history on every CI run. Locally the key is optional and lives in a gitignored `.env`.
