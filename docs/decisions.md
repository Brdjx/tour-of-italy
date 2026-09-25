# Decisions

Why the product is built the way it is. The main decisions come first, each with the alternatives considered; the rest follow, grouped by area. Each points at the code that carries it, where a `// Decision:` comment gives the local reasoning. Tests are described in [testing.md](testing.md), the system in [architecture.md](architecture.md).

## Main decisions

### 1. The model proposes, code decides

Context: a language model can invent places, misread opening hours, and return broken JSON, and travelers act on the plan.
Decision: Claude only picks a base per day and orders place ids from a shortlist, with a short reason per stop and a summary. The call uses structured outputs (`output_config.format` with a JSON schema, `services/api/src/llm/anthropic.ts`), the answer is parsed with Zod (`llm/schema.ts`), ids outside the shortlist are errors (`plan/materialize.ts`), the scheduler assigns every time and the independent validator checks the result. Before the check, code tidies what the model cannot see because code assigns the times (the owner's call, 2026-09-24: "code tidies, AI chooses"): it drops a place on its closed day, a repeat or a second place at one spot, and ordinary visits over the pace's limit, and puts a day the scheduler cannot time in an order the rules-only planner's day walk finds for the same places (`plan/tidy.ts`, `packages/planner/src/orderDay.ts`). When a day still holds more than its opening hours allow, it drops an ordinary visit (the latest one the hours cannot hold, or else the latest one, which frees time for what follows it) and orders the day again until it times cleanly, never a must-include or a meal the day needs, and keeps only drops that lower the day's errors (on the 45 first answers of the live eval of 2026-09-25, 43 then passed the check, against 14 without this step). Then it puts each place dropped for the hours back into the day's final order where it fits after all (the Bargello, dropped at 14:50, fits as the first stop), moving nothing else, only where the day keeps its meals and its visit limit and the check finds nothing new, and at the position that gives the day the most meals and then moves the other stops least. A restaurant, or another place that serves meals, goes back only as a lunch or dinner the day lacks, never as a visit, and then also when the visit limit dropped it, since as a meal it adds no visit (on those answers 12 of the 59 such drops come back and so does one restaurant the visit limit dropped, on 3,000 random answers 547 and 54, and none of those plans stops passing). It never changes a base or adds a place, and it keeps a must-include the model put only on its closed day, so the check reports the closure instead of a plan passing without it. A tidied plan is labelled `ai_repaired` and the log line lists what was tidied. The evals still count a mistake the tidy step fixed as the model's (`packages/evals/src/measure.ts`), and "first-pass valid" means the first answer passed exactly as written. One repair turn gets the exact violations that remain; every other outcome uses the rules-only plan (`plan/planTrip.ts`, `plan/outcome.ts`). Reasons and the summary are sanitized before they are shown.
Alternatives: let the model write the timetable (every time and travel claim would need checking and fixing); a forced tool call (a 400 on Opus 5.5 and Fable 5.1, while structured outputs work on every current model, so the call stays portable); no repair (more fallbacks); several repairs (they eat the 24 s deadline).
Why: the worst the model can do is a weaker choice among valid places. An invalid plan cannot leave the function.
Revisit if: evals show the model orders days better than the scheduler's timing allows, a repair rarely succeeds, or tidying drops many places for lack of time (47 over the 45 first answers of 2026-09-25, after the put-back): the model is choosing more than its days hold.

### 2. Source notes only ever make hours stricter

Context: seasonal notes and free-text hours mix restrictions ("Open April-October only", "Third weekend of each month only") with extensions ("Summer hours extend to 19:30").
Decision: restrictions become date rules (season, weekdays, day of month) and are applied; extensions are logged as `note_not_applied` and ignored; a restriction wording no rule understands is logged as `note_unread` and listed first in the data notes (`packages/planner/src/normalize/seasonRules.ts`, `normalize/noteGrammar.ts`).
Alternatives: apply every note; ignore notes and trust the hours field.
Why: a wrong "open" sends a traveler to a closed door, while a wrong "closed" only hides one option.
Revisit if: the data gains structured seasonal hours.

### 3. Five bases with day trips, not a radius

Context: the 103 places cluster in five cities (Rome, Florence, Milan, Venice, Bologna) plus satellite towns such as Siena, Pienza, Modena, Parma, Lake Como, Burano and Padua.
Decision: a city with at least 5 places is a base, and every other place joins its nearest base within 120 km (`MIN_PLACES_FOR_BASE`, `DAY_TRIP_MAX_KM` in `packages/planner/src/config.ts`, `anchors.ts`). A day visits only places of its base (`OUTSIDE_ANCHOR`), a trip uses at most 2 bases, and a second base must earn its transfer time (`TRANSFER_COST` in `planPolicy.ts`).
Alternatives: a 35 km radius around each base (every day trip in the data would be orphaned); free routing between any places (days that cross regions).
Why: every place belongs to exactly one base, day trips stay plannable, and each day stays in one area.
Revisit if: the data gains many small towns far from the five bases.

### 4. A four-band travel model with intercity rail

Context: there is no routing API, only coordinates.
Decision: straight-line distance in four bands, rounded up to 5 minutes, with 10 minutes between stops: walk up to 1.5 km at 4.5 km/h; local up to 20 km at 10 minutes plus 25 km/h; regional up to 150 km at 30 minutes plus 70 km/h; intercity beyond that at 45 minutes plus 170 km/h (`TRAVEL` in `config.ts`, `travel.ts`). Rome to Florence is 2 h 10 min and Rome to Milan 3 h 35 min. Legs inside the Venice lagoon too long to walk read "by vaporetto", and a leg onto or off a boat-only island (Burano, San Giorgio Maggiore) is never a walk.
Alternatives: one 80 km/h band (Rome to Milan would take 6.5 hours); a routing API (cost, latency, and a network call inside a planner that must run offline).
Why: realistic enough to plan a day, deterministic, free, and the same function serves the scheduler, the validator and the browser.
Revisit if: a routing API becomes available; the validator would then compare against it.

### 5. The rules-only planner is a product path

Context: plans must work with no key, during model outages and rate limits, and offline in the installed app.
Decision: `planDeterministic` (`packages/planner/src/plan.ts`) builds a full trip from rules alone in about 10 ms, returns identical JSON for the same input (no wall clock, ties broken by id), and never returns an error-level plan. It serves plans with no key, with `?mode=deterministic`, as the API's fallback, and in the browser when the API cannot answer (`apps/web/lib/planRequest.ts`). The source badge says which path made the plan and why.
Alternatives: show an error when the AI path fails; a simple top-N fallback.
Why: the traveler always gets a checked plan, local development needs no key, and the evals have a baseline.
Revisit if: evals show the AI path adds nothing measurable over it.

### 6. An independent validator

Context: plans come from the scheduler, the model, the traveler's edits, share links and stored plans.
Decision: `validateItinerary` (`packages/planner/src/validate.ts`, `validate/*`) never calls the scheduler. It recomputes travel, transfers, the hours on each date, day and meal windows, visit caps and must-include placeability from the plan itself, and checks claimed travel minutes (`WRONG_TRAVEL`). There are 27 codes, 19 errors and 8 warnings, with one severity table (`violations.ts`). The property tests add a third, first-principles re-check (`test/properties/hardRules.ts`).
Alternatives: trust the scheduler's output; validate model output only.
Why: a scheduler bug is caught instead of repeated, and the same check runs in the API and the browser.
Revisit if: a routing API replaces the travel model.

### 7. Static files plus one function, and one planner everywhere

Context: 103 places, three-day plans, no accounts and no stored trips on a server. The installed app must keep planning offline, and every AI plan is a paid model call.
Decision: the web app is a Next.js static export served by CloudFront from a private S3 bucket (`apps/web/next.config.ts`). The API is one Hono app on one Lambda function behind an API Gateway HTTP API (`services/api/src/lambda.ts`); the same app runs on Node for local development (`local.ts`). The planner is one pure TypeScript package with no I/O (`packages/planner`), bundled into both the function and the browser.
Alternatives: a Next.js server in a container (a server to run and patch for pages that never change per request) or on Vercel (a second platform next to AWS, and the planner would still have to run in the browser for offline use); a backend in another language (the validator would be written twice, and the two could disagree); a browser-only app (the API key would have to reach the browser).
Why: nothing runs between requests, so there is no server to patch and an idle month costs little. The browser checks every plan and plans offline with exactly the rules the server uses.
Revisit if: the product gains accounts or stored trips (a database and server rendering would then earn their place), or a plan must stream for longer than API Gateway's 30 s cap.

### 8. Layered spend limits on a public Claude endpoint

Context: anyone can call `POST /api/plan`, and Anthropic bills the model calls, so the AWS budget never sees them.
Decision: five layers, from the edge inward. The WAF allows 30 plan calls per IP per 5 minutes at the edge, on any spelling of the path (`infra/terraform/platform/waf.tf`). API Gateway allows the plan route 1 request a second with a burst of 6, and the function has 10 reserved instances (`infra/sam/template.yaml`). Inside each instance a token bucket allows 10 plans a minute per client (`services/api/src/lib/rateLimit.ts`), and a cache of 100 AI plans answers repeats (`lib/cache.ts`). By default a plan makes at most three model calls (a first answer, one repair, one retry of a brief failure), each capped at 8,000 output tokens and all inside the 24 s deadline. Rules-only plans (no key, `?mode=deterministic`, the smoke tests) make no model call.
Alternatives: sign-in or an API key for travelers (friction for a planner anyone can open); the WAF rule alone (a flood from many addresses passes it); no reserved concurrency (a flood could also starve the other stacks in the shared account).
Why: each layer covers what the one before cannot. The WAF stops one client at the edge, the gateway and the reserved instances cap all clients together, the bucket covers calls that reach the function, and the cache makes repeats free.
Revisit if: real traffic reaches the gateway throttle (raise it together with the reserved instances), or the product gains accounts (limit per account instead of per address).

### 9. Terraform bootstrap, platform and SAM, applied by different hands

Context: the AWS account is shared with other production stacks, and CI deploys through GitHub OIDC. IAM cannot scope the HTTP API, CloudFront distributions, origin access control, headers policy or certificate by name, and tag conditions are only as strong as the right to tag.
Decision: `infra/terraform/bootstrap` (admin only) holds the CI roles, the permissions boundary, the artifacts bucket and the budget. `infra/sam` (Lambda, HTTP API, logs, alarms) and `infra/terraform/platform` (certificate, DNS, bucket, both distributions, WAF, origin secret) are created by an admin once and updated by CI. The deploy role cannot change its own roles or policies, cannot create a role without the boundary, and is denied the Anthropic key (`bootstrap/deploy-guardrails.tf`). The six ids AWS generated on the first deploy are committed in `infra/terraform/bootstrap/deployed-ids.auto.tfvars`, and every CI right on those resource types names exactly those ids (`arns.tf`, `pins.tf`): CI can update them but cannot create or delete them, and a `check` block warns while any id is empty. gitleaks allows id-shaped values in that one file only.
Alternatives: one root applied by CI (CI could widen its own rights); everything in SAM (the stack would carry the roles that deploy it); tag conditions or rights on every resource of a type instead of pinned ids.
Why: a compromised workflow cannot grant itself more, and each layer is changed by whoever should own it. Pinned ids are the only scope another stack's resources cannot match, and a change that would replace a pinned resource fails with AccessDenied before anything is deleted.
Revisit if: the project moves to an AWS account of its own, or a pinned resource must be replaced (an admin applies, then re-pins).

### 10. Same-origin /api for the browser, plus a public API host

Context: the web app needs the API, and other clients (the post-deploy smoke test, curl and scripts, future tool clients) want plain paths. The evals run the production pipeline in-process, so they need no network and no WAF allowance.
Decision: the site distribution serves the bucket at `/*` and the HTTP API at `/api/*`, so the browser calls its own origin: no CORS in production, and `connect-src` is this origin only (the map tiles are served from the site too). A second distribution at `api.italy-planner.brdjx.com` has origin path `/api`, the same WAF, headers policy and origin secret, and sends no CORS headers (`infra/terraform/platform/cloudfront.tf`, `cloudfront-api.tf`).
Alternatives: the browser calls the API host (preflights on every plan, a second host in the CSP); site paths only for scripts.
Why: one WAF path covers every browser call, and the public host opens no way around the WAF or the origin check.
Revisit if: a browser client on another origin needs the API (it would need CORS).

### 11. Tests start from failure vectors

Context: the product fails badly in a few specific ways: an invalid plan, a hung model call, a leaked secret, runaway cost, a bad deploy.
Decision: twelve failure vectors, F1 to F12, each with a guard in code and tests named after the failure they prevent ([testing.md](testing.md)): fixed-seed property tests, a validator mutation suite with a corruption for every error code, a scripted model client for every API failure, E2E on six device profiles plus the installed app, `terraform test` with mocked providers, and a post-deploy smoke test. Coverage floors per area sit at the measured figures, so they only move up.
Alternatives: a coverage target alone; example tests only.
Why: each test proves a guard holds, and deleting a check fails a named test.
Revisit if: a failure reaches production that no vector covers; add the vector, then the test.

## All decisions by area

### Data

- **Hours carry their source.** Derived and open-access windows are stored as hours, with `hoursConfidence` (`listed`, `derived`, `open_access`, `unknown`) driving the chips. Precedence: listed hours, free text ("Evenings" 18:00 to 24:00, "Morning only" 07:00 to 13:00), a time of day in the name, open access, unknown (`normalize/hours.ts`, `dataPolicy.ts`).
- **Name hints fill empty hours only.** "by Night" 20:00 to 24:00, "at Dawn" 06:00 to 10:00, "Early Morning" 06:00 to 11:00, "Aperitivo" 17:30 to 21:00; listed hours always win (`NAME_TIME_HINTS`).
- **Public spaces with no hours are open 07:00 to 23:00**, but only when the raw type is a public space; a ticketed church with no hours stays unknown.
- **Unknown hours still plan**, inside the day window, ranked lower, with an `HOURS_UNKNOWN` warning.
- **Third weekend means a Saturday or Sunday on the 15th to the 21st**, and "last" counts back from the month's real end, so the rule is exactly as strict as the description.
- **A close before the open crosses midnight only when unambiguous** (closes by 06:00, spans at most 18 hours, and says "am", has a leading zero, or opens at 13:00 or later). "9-5" is not read as 20 hours open.
- **Wording that says a place is shut excludes the record** with reason `closed`; a closed part of a place is only a note.
- **Meals come from the hours.** A restaurant keeps lunch or dinner only if some open day can seat that meal, so five restaurants serve one meal. Eight non-restaurants are meal places through a reviewed allowlist with a reason each (`EXTRA_MEAL_PLACES` in `dataPolicy.ts`).
- **Visit lengths**: a missing length takes the type default, one outside the type's bounds is clamped, and one longer than the longest open range is cut to fit it.
- **Coordinates far from the city are repaired**: more than 40 km from the median of the city's other places moves the point to the median of its neighborhood, else its city (Brera market lands within 0.1 km of the Pinacoteca), shown as an approximate location.
- **Places and excluded records are separate lists**, so no consumer can plan an excluded record by mistake; places plus excluded always equals the records read.
- **Ids are resolved first** and kept when safe (`[A-Za-z0-9_-]{1,64}`); they appear in URLs, prompts and map keys.
- **Duplicates merge by folded name and city.** Identical coordinates with different names (Trevi Fountain by day and by night) are kept and linked, and a trip holds at most one of them. Reviewed same-experience pairs are linked the same way.
- **Prices are levels 1 to 4**; "free" counts as 1, and a tag that disagrees with the price is logged, not applied.
- **Places rated below 3.5 are never suggested**, but a traveler can still ask for them.
- **Lookup tables ignore inherited keys** (`Object.hasOwn`), found by fuzzing: a price of `__proto__` once returned `Object.prototype`.
- **Text over 300 characters is never pattern-matched**, so hostile megabyte strings normalize in milliseconds.
- **Dates use `Date.UTC` only**, and the planner's `tsconfig.json` has no Node types, so a local-time call or a Node import fails a guard.
- **The source file is never edited.** Fixes live in code and reviewed tables, and a checksum test fails on any edit to `data/italy.json`.

### Planner

- **Roles are inferred from the order.** The model, share links and edits carry ids only; a meal place becomes the next meal it can seat if that meal starts within 60 minutes (`inferRole`, `schedule.ts`).
- **One timing function** (`timeStep`) serves the planner and `scheduleDay`, so re-timing a plan from its ids gives identical stops and a share link reproduces the plan.
- **Greedy days with one look-ahead.** Each pick keeps the meal on offer reachable, using latest start times (`dayLimits.ts`, `dayPicks.ts`). Two picks look at the other days: a meal goes to the meal place with the fewest meals left elsewhere, and a morning sight no later day can hold beats a nearly as good pick.
- **Days take turns by clock**, earliest clock first, so day 3 no longer gets the leftovers (`tripWalk.ts`).
- **Bases are chosen by building whole trips** for the top 3 bases (plus any base holding a must-include), alone and in pairs, ranked by must-includes kept, then score minus transfer cost; a mistimed must-include costs 20 points (`tripBuilder.ts`, `planPolicy.ts`).
- **Chosen bases are kept** as long as each day can hold a place there, except where the walk gives one day the only place another day could use: 14 of 19,962 such requests in a measurement, bounded at 1 in 1000 by a property test. A day away from a chosen base always says so with `ANCHOR_NOT_CHOSEN`.
- **Passes after the walk never break a hard rule**: the must-include repair (removing as few ordinary stops as it can) and the meal fill (`mustRepair.ts`, `mealFill.ts`); an empty day may take one public space (`tripWalk.ts`). Every rule was kept or removed by measuring the planner without it on three seeds; the route pass, meal sharing, and the other rescues did not clear the bar. The numbers are in [planner.md](planner.md#the-rules-in-the-order-they-run-and-what-each-buys).
- **Meal places are for meals**, and restaurants are never visits unless the traveler asked for them.
- **Outings** (a non-meal visit of 240 minutes or more) start by 12:00 unless the traveler asked for them, and cover a meal they span for 60 minutes; a day trip pays for at most 10 km of distance in the score.
- **Taste rules are planner preferences, not validator errors**: parks end by sunset, aperitivo after 17:00, gelato and wine bars after lunch, museums avoid 25 December and 1 January. They never keep out a must-include.
- **One day window, meals inside it.** Every stop fits the pace window, and the trip back to the base is a hard rule; after a final dinner it may end 30 minutes past the day end (`DINNER_RETURN_GRACE_MIN`).
- **Scores are rounded to 6 decimals and ties break by id** with plain comparison, never `localeCompare`, so the browser and the Lambda agree.
- **Headline sights lead when there are no interests** (an iconic bonus of 0.75); an interest match is worth up to 3.
- **A meal one price level over the budget** is used only when nothing within budget can take that meal, with an `OVER_BUDGET` warning.
- **Swaps only offer what keeps the day valid**, checked by the scheduler and the validator (`alternatives.ts`).
- **Warnings come from the validator only**, for new plans and edits alike.
- **Rule reasons' date sentences are the planner's own hours answer** for that stop and date ("It cannot be visited on Sunday, the trip's last day.", "Starts as it opens."), stated as facts, never as causes, and left out when the listing says more than the planner reads, when its note leaves the dates to the traveler (the risotto festival's "check exact festival dates"), and for every place on 25 December and 1 January, which have no holiday hours in the data (`reasons.ts`).
- **An AI reason is kept only while it holds for the stop as timed**: a meal, a part of the day, the sun, or a place in the day or trip that the stop does not bear out drops it for the rule reason (`packages/planner/src/reasonClaims.ts`). The API checks it on a new plan and logs `wrong_meal`, `wrong_time_of_day` or `wrong_position`; the planner checks it again whenever an edit on the page times the stop anew, so "to start the day" never follows a stop to third place. A meal word on a visit holds only somewhere to eat (a meal place, a cafe or restaurant, a place tagged food, or an outing under way through the meal), in that meal's window, on a day with no other stop for it, and the evening starts at sunset when the sun sets before 18:00.
- **Validator details**: the first stop is reached from the base; `SEASONAL_CLOSED` (another date helps) differs from `CLOSED_AT_TIME` (another time helps); a third meal counts as a visit; times are whole minutes up to 06:00 the next day; details are cut to 500 characters and never echo unknown ids.
- **Must-include placeability**: `MUST_INCLUDE_MISSING` is an error only when the plan clearly had room; otherwise `MUST_INCLUDE_UNPLACEABLE` explains why (`validate/mustInclude.ts`).
- **`TRIP_DAYS` is 3** and the suite passes at 3 and 4. A trip must end by 2100-12-31, so request and response schemas agree.

### API and AI

- **Length limits live in Zod only.** Structured outputs ignore them, and a long reason should cost that reason, not the whole answer.
- **A per-model settings map** (`llm/models.ts`): Sonnet 5 gets `effort` (default low) and no temperature, Haiku 4.5 gets temperature 0.2 and no effort; unknown ids get neither. `max_tokens` 8000.
- **The shortlist is enforced and borrows the fallback's bases**: up to 4 bases, 12 visits and 5 meal places each; a base the rules-only plan needs is offered too (`plan/candidates.ts`).
- **Timing**: 24 s deadline from arrival, each call at most 12 s, 1.5 s reserve, no first call under 2 s and no repair under 4 s. Function timeout 29 s, API Gateway cap 30 s.
- **No SDK retries; one deadline-aware retry** for a dropped connection, a 5xx, an overload, or a 429 asking to wait at most 1 s.
- **A tidied plan is never "ai".** Only an answer that passes the check exactly as the model wrote it is labelled `ai`; one the tidy step changed is `ai_repaired` ("fixed after a check"), whose badge text names both ways a draft is fixed, and the log's `tidied` field lists each change with its rule, day and place (`plan/planTrip.ts`, `apps/web/lib/sourceText.ts`).
- **Tidying keeps the model's order when the scheduler can time it**, and otherwise takes the walk (of two: the planner's own picks, or every place as soon as it can start) whose order times with the fewest errors, only when that is fewer than the model's. A day holding an id not offered or a place of another base keeps its order and length: the check sends it back anyway.
- **Tidying never takes a must-include out of the answer.** It is never trimmed or dropped for sharing a spot, and on its closed day it is dropped only when the answer also has it on a day it is open. Dropped from its only day, a plan could pass without it: when that day is the trip's only one at its base, the validator only warns (`MUST_INCLUDE_UNPLACEABLE`), though another order of bases would fit it. Kept, the check names the closure and its date, and the repair turn or the rules-only planner places it.
- **Every failure has a fallback reason** (`refusal`, `max_tokens`, `rate_limited`, `timeout`, `llm_error`, `schema_invalid`, `invalid_after_repair`, `no_key`, `disabled`, `requested`), shown in the UI and the log.
- **AI plans carry exactly the validator's warnings**, so the browser shows the same list.
- **Only AI plans are cached** (100 per instance, keyed by prompt version, model and the canonical request, stored and returned as copies); a fallback is never pinned.
- **Reasons and summary are grounded**: dropped for another place's name, a time, duration or price, links, contact or payment details, injection wording in six languages, prompt echoes, or a capitalized word the dataset never uses.
- **The origin check fails closed**, re-reads SSM at most every 10 s on a mismatch, and accepts the previous secret for 15 minutes after a rotation is seen.
- **The key is re-read every 15 minutes** and after a 401 or 403 (at most once a minute), so a rotated key reaches warm instances without a redeploy.
- **Rate limit key**: `CloudFront-Viewer-Address`, then the first `X-Forwarded-For` entry; IPv6 by /64.
- **JSON only** (415 otherwise), and the 16 KB cap counts bytes read, not the header.
- **Error bodies never reflect input**; a 500 carries a fixed message and the request id. No feasible plan is 422; a rules-only plan failing its guard is 503.
- **Read routes are cacheable** (strong ETag, `max-age=300, s-maxage=3600`); everything else is `no-store`.
- **Metrics ride on the request log line** (Embedded Metric Format), so handled 500s and silent fallbacks can alarm without new IAM rights.
- **Config fails fast**: deadline at most 26 s, 2 or 3 attempts, `NODE_ENV=production` inside Lambda, fixture mode refused in production, the origin check on whenever its parameter is set.
- **CORS only outside production**, and the local server binds to 127.0.0.1.

### Web and PWA

- **Every API body is parsed with Zod**: strict for places and itineraries, loose for envelopes; schema errors carry field paths, never values.
- **The form works from the places alone**; `/api/meta` only refines labels.
- **The browser plans for anything except a refused request.** Network errors, timeouts, 5xx, 429 and unreadable replies get a local plan labelled with the real cause; a refused request (400, 413, 415, 422) shows the error and names the fields the API listed.
- **The page validates the API's plan** before showing it, and replaces a plan with errors by a local one.
- **Edits are kept and flagged, not blocked**, with up to 10 undo steps.
- **Share links carry ids only and never notes**, capped at 8 KB, and repair instead of failing: unknown or excluded ids are dropped, flagged stops are left out until the validator is clean, and every outcome shows a note.
- **The last plan is stored whole and read as hostile input**: discarded when over 100,000 characters, invalid, older than 90 days, past, or naming unknown places.
- **The source badge never claims more than the page knows**, including "Shared plan" for links.
- **The map is a visual aid** and the timetable its text equivalent; a failed map chunk, a missing worker or no WebGL shows a notice.
- **A self-hosted vector map, not Google Maps** (the owner's choice). MapLibre GL draws a Protomaps extract of only the areas the trip uses (about 140 MB, three zoom bands: `scripts/map-tiles/`), styled in the page's palette with a real dark mode. The file is uploaded once to the site bucket under `tiles/` and deploys never delete it; the page makes no third-party request, needs no key and tracks no one. MapLibre's worker and glyphs are precached so an offline plan still draws its route and stops; the tiles are not. Changing day glides the camera, or jumps under reduced motion.
- **The service worker is hand-written** (`apps/web/public/sw.js`) and tests run that exact file in a sandbox. `POST /api/plan` and all other API calls except `GET /api/meta` and `/api/places` bypass it.
- **Cache names come from a content hash**, and the shell's hash is checked at install.
- **Updates wait for a tap** ("A new version is available"); first installs are silent.
- **Safe areas and `100dvh`** live in CSS custom properties; targets are at least 44 px and inputs 16 px.
- **Zod runs jitless**, so the CSP needs no `unsafe-eval`.
- **One column on every screen.** Before a plan the page is the date, the pace, More options and Plan my trip; once a plan is on screen or on its way the form folds into a one-line trip summary with Edit trip, on phones and desktops alike. This replaces the build plan's two-pane desktop sketch: the plan gets the full width and the form stops competing with it (`apps/web/app/styles/layout.css`).
- **TikTok Sans with every axis, self-hosted**, the face the Goodpix reference uses; width marks rank. A local Arial face with TikTok Sans's measurements stands in while it loads, because next/font has no metrics for this family (`apps/web/app/layout.tsx`, `globals.css`).
- **The departure board, in the Goodpix language** (the owner's reference). Ink is the only fill and gold only draws, containers and photos are square and anything pressed is a pill, hairlines instead of boxes, and TikTok Sans's width marks rank while weight marks state. Each day reads as a departure board: condensed tabular times in a left column, the moves beside them. Motion explains a change once: the board flips in when a plan arrives, only the times an edit moved flip afterwards, and under reduced motion everything crossfades. The product record is `apps/web/PRODUCT.md` and the direction contract `apps/web/.impeccable/surfaces/app-page-tsx.md`.
- **Photos are real Wikimedia Commons photos, credited.** 73 places have a photo of that exact place, each checked by eye; the others show their city's photo inset on a mat and labelled, never as the place. Each credit names the author as they ask to be credited, links the licence and the Commons page. The photos are downloaded once at 500 and 960 px and served from the site (`data/place-photos.json`, `scripts/fetch-place-photos.ts`, `apps/web/lib/placePhotos.ts`); the service worker does not precache them. Two highlight photos (the Colosseum, the Duomo di Milano) carry Italy's cultural heritage restriction, which only binds commercial reproduction.

### Infrastructure

- **OIDC trust uses GitHub's immutable subject** with repository and owner ids, requires the owner's `actor_id`, and pins the deploy role to `deploy.yml` on `main` and the plan role to `ci.yml` on pull requests.
- **The plan role is a custom read list** with explicit denies; managed read-only policies would expose other stacks' data.
- **No HTTP API, WAF or CloudFront logs**: each needs an account-wide log policy in a shared account. The function logs every request that reaches it.
- **CSP**: `script-src 'self' 'unsafe-inline'` because the static export's inline payloads change every build and headers cannot carry nonces; no `unsafe-eval`; `worker-src` and `manifest-src 'self'`.
- **`/api/*` is HTTPS only** (a redirected POST loses its body), and API errors are never cached at the edge.
- **The boundary works only for the function's own code** (`lambda:SourceFunctionArn`), so a changed trust policy gains nothing.
- **CI cannot delete** the distributions, the web bucket or the stack.
- **WAF**: plan calls 30 per IP per 5 minutes on any spelling of the path, all calls 2000; the body-size rule blocks, the query-string size rule only counts so long share links load.
- **Managed cache policies by literal id**, so tests catch an `/api/*` behavior that caches.
- **The API host reuses the site's headers policy**: one policy to review and pin.
- **Host names are limited to the `italy-planner.brdjx.com` subtree** in both roots.
- **Lambda**: `nodejs24.x` on arm64, 512 MB, 29 s timeout, 10 reserved instances; six alarms, including handled server errors and the share of AI plans whose model call failed.
- **SAM uses its own artifacts bucket** and no `sam build`, so the deployed bundle is the tested bundle.

### CI/CD

- **Every third-party action is pinned to a commit SHA**; Dependabot proposes updates weekly after a 7-day cooldown.
- **`ci-ok` rolls every CI job into one status**: it fails on a cancelled run and lets only the plan job skip. A deploy starts only after a successful `ci` run for a push to `main` (the `gate` job in `deploy.yml`). Making `ci-ok` a required check needs branch protection, which the repository's GitHub plan does not offer yet ([deploy.md](deploy.md#github-plan)); until then, merge only green pull requests.
- **gitleaks, trivy, actionlint, Terraform and SAM CLI are downloaded and checked against pinned SHA-256 digests**, never restored from a cache.
- **Only commits on `main` deploy**, rollbacks included, and an automatic deploy only moves production forward (`deploy-guard.sh`).
- **Build and deploy are separate jobs**: third-party build code runs without credentials; the deploy job runs pinned tools on the artifacts.
- **Deploy scripts come from the workflow's own commit**, so a rollback runs today's deploy logic.
- **`samconfig.toml` is the single source of deploy parameters**; CI appends `GitSha` last.
- **Pull requests cancel superseded runs; every push to `main` gets its own run.**
- **Accepted scanner findings are suppressed inline** with a reason, never in a central ignore file.
- **Live evals never run on pull requests** and never gate a merge or a deploy; CI runs the offline replay, which enforces plan validity only; model quality numbers are reported, not enforced.

### Testing

- **Planner properties run 500 times with a fixed seed** in every run and 5,000 with `pnpm test:props`; a failure prints its seed.
- **Plans are memoized per test file**, so each property keeps its own name at a third of the CPU.
- **Performance is asserted at 5 times the budget**, which catches a blow-up without flaking.
- **E2E reports but does not block during the redesign** (owner's call, 2026-09-24). The job still runs on every push; it leaves `ci-ok` until the specs are rewritten for the new page (task T62).
- **E2E runs under the production CSP and routing** through `e2e/serve.mjs`, with a fixed clock, one rate-limit bucket per test, and specs routed to projects by file name instead of being skipped.
- **Service workers are blocked on device projects** and tested in their own project.
- **Any console error fails an E2E test**, except the browser's own line for an injected failed load.
- **Coverage floors per area**, so one well-covered package cannot hide another.
