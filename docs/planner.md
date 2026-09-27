# The planner

`packages/planner` is pure TypeScript with no I/O. The same code runs in the Lambda and in the browser.

## What it does

1. It turns a trip request (start date, pace, interests, budget, bases, must-includes, exclusions) and the 103 normalized places into a timed three-day itinerary.
2. It chooses one or two bases, then walks the days in turns. At each step a day takes the best stop that fits the hard rules and the day's preferences.
3. A repair pass puts back any must-include the walk left out. A meal pass then seats any lunch or dinner the walk missed, and where adding cannot seat it, gives up the day's least valuable ordinary visit for it. The API runs the adding half on an AI answer once it passes the check (`addMissingMeals`, [decision 17](decisions.md#17-a-missing-meal-says-why-a-city-warns-before-and-code-adds-the-meal-the-ai-left-out)): the model's stops all stay, in its order.
4. The scheduler times every stop from the place ids alone, so AI plans, shared links, and edits are all timed by the same function. When the model's order for a day cannot be timed, the API's tidy step puts the model's own places in the order this day walk finds for them (`orderDay.ts`); it never adds a place or changes a base (only after the check may code add a lunch or dinner a day lacks, decision 17), and the plan is then labelled `ai_repaired`. When a day still holds more than its hours allow, the tidy step drops the latest ordinary visit the hours cannot hold (or else the latest one) and orders the day again until it fits, never a must-include or a meal the day needs. It then puts each of those visits back where the day's final order holds it after all (an early-closing museum as the first stop), moving nothing else and only where the scheduler and the validator find nothing new. A restaurant or other meal place goes back only as a lunch or dinner the day lacks, never as a visit, even one dropped to keep the day within its visit limit. What a day still cannot hold (its closed day, the visit limit, or the hours) moves to another day at the same base that holds it the same way, and a day the repeat rules would empty keeps one of its places, so a model's answer that repeats day 1 on day 3 still gives day 3 a stop; a day they would leave with meal places only keeps one of its visits, when the day it came from has another. A restaurant the model placed outside the meal windows moves to where it is the lunch or dinner the day lacks. Where that is not enough, the day takes the nearest order of its own stops that gives its meal places their meals, a restaurant over the budget is only ever a meal (moved to a day at its base that lacks one, or else dropped), and of a restaurant and a visit at one spot the restaurant stays when the trip then has more meals.
5. An independent validator checks every plan again from its own stop times. A plan with an error never reaches the traveler. A day it warns has no lunch or dinner gets a cause from `mealSupply.ts`: none open (no place of the base the traveler does not avoid can take that meal that date, each with its reason, such as Bologna's dinner places on a Monday) or not planned (a place could).
6. Once a trip exists, the traveler can set a city for each day by hand, in any order and back again (Rome, Florence, Rome): up to a city a day, with the travel stated as facts instead of refused (`dayRoute.ts`, [decision 16](decisions.md#16-a-city-a-day-set-by-hand)). The planners themselves keep to at most two bases and one change of base.

## Pipeline

```
data/italy.json
  -> normalize        normalize/*            raw records to Place[] plus an issue log (data policies below)
  -> bases            anchors.ts             cities with 5+ places; other places join the nearest base within 120 km
  -> choose bases     tripBuilder.ts         tiers of arrangements (planAnchors.ts): chosen bases first, then the
                      planAnchors.ts         3 best-ranked plus any base holding a must-include; per arrangement:
                                             build the trip, repair must-includes, keep the best by must-includes
                                             placed, then score minus transfer cost minus mistimed must-includes
  -> build days       tripWalk.ts            days walked in turns, earliest clock first; one shared set of used places
                        dayBuilder.ts        per step: time every unused pool place as the next stop, keep options
                        dayLimits.ts         that start by their latest start (open, back to base in time)
                        dayRules.ts          and keep the day rules
                        dayPicks.ts          pick: must-include now > due meal > best visit now > soonest,
                                             keeping the meal promise; the due meal goes to the meal place
                                             with the fewest meals left on other days; a morning sight no
                                             later day can hold beats a nearly as good top pick; an empty
                                             day may take one public space
                      mustRepair.ts          insert a missing must-include, removing ordinary stops only
  -> meals            mealFill.ts            seat a missing lunch or dinner at an unused meal place;
                                             where none fits as an addition, give up a visit for it
  -> schedule         schedule.ts, trip.ts   time the ids: arrival, opening, meal windows, roles, reasons
  -> validate         validate.ts, validate/ recompute every check from the plan's own times
  -> alternatives     alternatives.ts        swaps and edits in the browser; every rebuilt day re-validated
```

## Files

| File | What it owns |
|---|---|
| `index.ts` | The public entry point: what the API, the web app, and the scripts import. |
| `types.ts` | The shared types every package imports. |
| `enums.ts` | The runtime lists behind the union types (paces, place types, violation codes). |
| `schemas.ts` | Zod schemas for requests and itineraries, with compile-time checks against the types. |
| `dataSchemas.ts` | Zod schemas for places and data notes, and the type-check helpers both schema files use. |
| `config.ts` | Hard-rule tunables: trip length, pace windows, meal windows, travel bands, bases, score weights, request limits. |
| `dataPolicy.ts` | Data-cleaning tables: visit lengths, derived windows, reviewed meal places and corrections, and the owner's flagship places. |
| `planPolicy.ts` | Tunables only the rules-only planner reads: idle limits, transfer cost, the last-chance margin, sunset table, day-rule times. |
| `clock.ts` | Clock text to minutes and back. |
| `time.ts` | Calendar maths in UTC and `hoursOn`, the one answer to "open on this date". |
| `travel.ts` | Straight-line travel model: four distance bands, Venice water rules, labels, `latestReturn`. |
| `anchors.ts` | Bases, transfers between them, and `dayOrigin`, where every day starts and ends. |
| `context.ts` | `PlannerContext`: places, bases, and lookups built once per dataset and frozen. |
| `constraints.ts` | Hard-rule predicates shared by the scheduler, validator, swaps, and the AI shortlist. |
| `score.ts` | How much a traveler would want a place next (interest, rating, iconic, the owner's flagship places, distance, repeats). |
| `reasons.ts` | Rule-based reason text per stop: the request, what the stop's date means for it (shut on the trip's other days at its base, opening later that weekday, starting as or soon after it opens), the listing's iconic and local favorite tags, the day's highest rating, the rating, the listing's morning or evening tag when at least half the visit is then, and an outing's meal. |
| `schedule.ts` | `scheduleDay`: times a fixed order; `inferRole` decides visit, lunch, or dinner from arrival. |
| `scheduleChecks.ts` | The problems `scheduleDay` reports while timing. |
| `reasonClaims.ts` | `contradictedClaim`: what an AI reason says about its stop's meal, time of day, sun, or place in the day or trip, checked against the stop as timed. The API and `trip.ts` both use it. |
| `trip.ts` | `scheduleTrip`: times a whole trip from ids per day and attaches reasons, given every day's date and base so a reason can name the trip's other days. An AI reason carried through an edit stays only while `contradictedClaim` finds nothing. |
| `plan.ts` | `planDeterministic` (the pipeline above) and the warning order. |
| `planAnchors.ts` | Which arrangements of bases to try, in which tiers. |
| `tripBuilder.ts` | `chooseTrip`: the best trip over the arrangements, transfer cost, mistimed must-includes. |
| `tripWalk.ts` | `buildTrip`: turns between days, what the other days could still use (the meal hold, meals and visits elsewhere), the empty-day rescue, holiday must-include days. |
| `pools.ts` | The candidate places per base, including meal places one price level over the budget (`isMealFallback`, which the API's AI shortlist uses too), and `isBlocked` (a place the trip already holds). |
| `dayBuilder.ts` | One day's walk: `startWalk`, `stepWalk`, `buildDay`, and which places are options. |
| `dayPicks.ts` | The four picks, the meal promise, the least flexible meal place, and a morning sight's last chance. |
| `dayLimits.ts` | Latest start per place and role, so the look-ahead is one comparison. |
| `dayRules.ts` | The day's preferences: outings by noon, parks by sunset, treats after noon, one trip out of town. |
| `mustRepair.ts` | Inserts must-includes the walk left out. |
| `mealFill.ts` | Seats missing meals after the walk: adds first on every day, then gives up one ordinary visit for a meal adding could not seat. `addMissingMeals` is the adding pass alone, for days the planner did not choose (the API's AI answers). |
| `mealSupply.ts` | Why a day has no lunch or dinner: `dayMealGaps` and `mealGaps` (none open or not planned, each place of the base and why it cannot take the meal, with its town when outside the base's city, one sentence), `mealPlaces`, `mealsMissing` (the meals a day has no stop for, as the validator counts them), and `mealFacts`, the fact a route day or a city states before it is chosen ("No dinner place listed for Bologna opens on Mondays."). |
| `alternatives.ts` | Swap candidates and `rescheduleDay` for edits in the browser; a place to eat may replace a visit when it gives the day a lunch or dinner it lacks, and those come first. `withReplannedDay` and `withReplannedDays` apply days planned again as one edit. |
| `planDay.ts` | `planDay`: one day of an existing trip planned again by the rules at a base, the other days' places counted as used. |
| `dayRoute.ts` | `planRoute`: a city a day set by hand, what it means for each day (travel, start, days planned again and why, facts, and the meals no place of its city can take that date), the rare refusals with a way out, and the days planned by the rules in day order; `dayTravel` for a planned day's travel facts. |
| `dayBases.ts` | The cities one day can take (`dayBaseOptions`, `routeOptions`), and `checkDayBase`, the check for planning one day. |
| `dayChecks.ts` | The validator's errors for a trip held as ids, `newTripErrors`: which ones a re-planned day brought, and `mustIncludesLeftOut`: a must-include the rules' day holds that another answer for the day leaves out. |
| `stopEdits.ts` | Remove, move, and replace helpers that return a day's new ids. |
| `orderDay.ts` | `orderDay`: the day walk over a fixed set of places, which the AI path's tidy step uses to order a day the scheduler cannot time as the model wrote it. |
| `validate.ts` | The validator's entry: trip shape (at most a base a day, or `maxBases`), then each day, then must-includes. |
| `violations.ts` | The one severity table and the one violation constructor. |
| `validate/days.ts` | Day facts rebuilt from the plan; each day's date, transfer, base, and emptiness. |
| `validate/stops.ts` | Unknown ids, stop times, the day window, meal windows, overlap, and travel between stops. |
| `validate/stopPlace.ts` | Duplicates, exclusions, shared spots, the base, meal places, hours on the date, budget, rating. |
| `validate/dayTotals.ts` | The visit cap, both meals, and the trip back to the base. |
| `validate/mustInclude.ts` | Missing must-includes: an error when placeable, a warning with the reason when not. |
| `validate/mustIncludeFit.ts` | Which days a missing place could have gone on, and why not. |
| `validate/text.ts` | Plain-language pieces for violation details. |
| `normalize/index.ts` | `normalizePlaces` and `buildDataset`: raw JSON in; places, excluded records, issues, summary out. |
| `normalize/record.ts` | One record, field by field. |
| `normalize/raw.ts` | The raw source format, every field optional. |
| `normalize/ids.ts` | Safe, unique place ids. |
| `normalize/issue.ts` | Building issues and reading raw text safely. |
| `normalize/hours.ts` | The hours policy: listed, derived, open-access, or unknown. |
| `normalize/hoursParser.ts` | The grammar for listed hours. |
| `normalize/dayWords.ts` | Day names and day lists shared by hours and notes. |
| `normalize/seasons.ts` | Seasonal notes read into date rules. |
| `normalize/seasonRules.ts` | One clause of a note, read only ever stricter. |
| `normalize/noteGrammar.ts` | The note wordings that restrict or widen dates. |
| `normalize/names.ts` | Name, city, region, neighborhood, description. |
| `normalize/placeType.ts` | Canonical place types. |
| `normalize/tags.ts` | Canonical tags and labels. |
| `normalize/price.ts` | Price level 1 to 4. |
| `normalize/rating.ts` | Ratings on a 0 to 5 scale. |
| `normalize/duration.ts` | Visit length: listed, type default, or clamped. |
| `normalize/meals.ts` | Which meals a place can serve. |
| `normalize/geo.ts` | Coordinates inside Italy. |
| `normalize/locations.ts` | Coordinate repairs across records. |
| `normalize/crossRecord.ts` | Missing cities and regions, duplicates. |
| `normalize/sharedLocations.ts` | Places never put in the same trip. |
| `normalize/chips.ts` | The short data notes shown next to a place. |
| `normalize/issueText.ts` | Plain-language text per issue kind (booking and clean-up kinds in `issueTextCleanup.ts`). |
| `normalize/issueTextCleanup.ts` | The second half of that table. |
| `normalize/summary.ts` | The "About this data" summary. |

## The rules, in the order they run, and what each buys

Each rule was taken out of a copy of the planner as it was at commit 5df0a0b, and the copy planned the sweep (below) on three seeds (20260924, 11, and 12) and all four profiles. The judge was that same original planner's validator and day rules, so a rule that was later removed from `dayRules.ts` still counted.

**The bar.** A rule stays when removing it makes a metric worse, on the mean of the three seeds and a whole profile, by at least 2 points on a share, 0.1 visits a day, 10 minutes of travel or waiting a day, or 0.2 iconic sights a trip, or when it causes a validator error or a planner failure. Judging on the worst single seed instead of the mean keeps the same rules; the one difference, the later-meal promise's second try, went with the promise it served (below). Then the removals together must stay under the bar on every seed, and no sight may drop out of one kind of trip (the place-level check below). Both later checks put a rule back: meal flexibility, because without it the other removals missed a meal on 1.6, 1.9, and 2.3 points more mixed days on the three seeds; and a morning sight's last chance, because without it no Rome trip starting on a Sunday included the Vatican Museums.

**Reading the table.** "Without it" is the three-seed mean, with the range in brackets, on the profile where the change is largest. For a day rule, the out-of-town rule, and meal places as sights, the metric is the rule itself, so the number says how often the rule binds, not that travelers gain; those rows say "binds in", add the largest change in any metric that does not come from the rule, and rest their case on the "Why" column (a fact about Italy, or a matter of taste). "Cost of keeping it" names every metric that removing the rule would improve past the bar.

| Step | Rule | Where | Why | Without it | Cost of keeping it |
|---|---|---|---|---|---|
| Choose bases | Try the 3 best-ranked bases (plus any with a must-include) before the rest | `planAnchors.ts` `automaticTiers` | Speed | 46 of 3000 plans change, no metric by more than 0.3; 2.3 times slower at p50 (7.8 ms, not 3.4) and 2.6 times at p95 (17.7 ms, not 6.9) | none |
| | A change of base costs 10 points plus 1.5 an hour | `tripBuilder.ts` `transferCost` | A second base means packing up and 1 to 3 hours on a train, which the travel metric does not count | trips with 2 bases +36.9 [35.2 to 37.8] (holiday), +36.4 (mixed); transfers over 3 h +6.4 [6.2 to 7.0] (holiday) | days missing a meal +4.7 [4.5 to 4.8], interest match 3.6 points lower [3.5 to 3.7], 0.76 fewer iconic sights a trip (mixed): a second city's places. The default keeps one hotel; a traveler who wants two cities chooses them |
| | A must-include timed against a day rule costs 20 points | `tripBuilder.ts` `mistimedMustIncludes` | A requested museum on Christmas Day, or a requested day trip at 15:00, when another arrangement times it right | binds in +4.0 [3.1 to 5.3] of placed must-includes (holiday); nothing else moves 1 point | none |
| | Must-include repair inside the comparison | `mustRepair.ts` `repairMustIncludes` | A placeable must-include left out is a validator error | 4.3 validator errors in 1000 must-heavy plans [4 to 5] | none |
| Build days | Days walked in turns, earliest clock first | `tripWalk.ts` `nextTurn` | Filled in order, day 1 takes the best of everything and day 3 the leftovers | trips with a starved day +12.3 [11.5 to 13.2] (thin), +7.6 (mixed) | days missing a meal +2.7 [2.4 to 2.9] (mixed), lunch +3.8 (thin), dinner +2.1 (must), 0.11 fewer visits a day: filled first, day 1 is fuller. A day with one visit is most of a lost day; a missing meal carries a warning, and a cafe nearby still serves |
| | A fed day leaves a scarce meal place to a day with none | `tripWalk.ts` `wantedByMealless` | Bologna and Milan have three or four meal places for six meals | trips with a starved day +2.3 [1.7 to 3.2] (holiday); in the final planner, days with no meal +2.4 to +3.3 (mixed, thin, holiday) | none |
| | A must-include museum avoids 25 December and 1 January when another day fits | `tripWalk.ts` `mustIncludeDays` | Fact: most museums close then, and the data's hours do not say so | binds in +5.2 [4.7 to 5.9] of placed must-includes (holiday); trips with 2 bases +2.2 [2.0 to 2.5] (holiday) | none |
| | An empty day may take one open-access public space | `tripWalk.ts` `rescueEmptyDay` | Keeps the traveler on the base they chose when closures and a low budget empty a day | chosen-base trips moved to another base +2.6 [1.8 to 3.2] (thin); in the final planner +3.9 [3.0 to 4.6] | none |
| | Meal places one price level over the budget, only for a meal | `pools.ts` `isMealFallback` | A meal one level over, with a warning, beats no meal | days with no meal +24.3 [24.0 to 24.6] (thin); days missing a meal +13.3 [12.7 to 13.9] (mixed) | stops over budget +13.4 [13.2 to 13.7] (thin) and +4.4 (mixed), each with an `OVER_BUDGET` warning; days with a wait over an hour +3.5, 0.19 fewer visits a day (thin) |
| | Meal places are only meals, unless requested | `dayLimits.ts` `mayVisit` | A restaurant planned as a sight is a meal at the wrong hour | binds in +12.6 [11.8 to 13.8] of trips (must); nothing else moves 1 point | none |
| | The meal promise: take a stop only if the meal on offer stays reachable | `dayPicks.ts` `keepsMeals` | Without it a long visit runs through the only lunch the day could reach | days missing a meal +2.8 [2.5 to 3.0] (must); lunch +2.3 (thin, must) | none |
| | Meal flexibility: the due meal goes to the meal place with the fewest meals left on other days | `dayPicks.ts` `leastFlexible`, `tripWalk.ts` `mealsElsewhere` | Florence has four lunch places and Venice three; a lunch at a place that could also be a later dinner can leave that day without one | alone +1.2 [1.1 to 1.2] (mixed), under the bar; in the final planner, days missing a meal +1.6, +1.9, +2.3 (mixed) | none |
| | A morning sight's last chance: a nearly as good morning sight that no later day can hold beats the top pick | `dayPicks.ts` `lastChance`, `tripWalk.ts` `visitsOn` | The Vatican Museums close on Sundays and must start by noon; days 2 and 3 each left them to the other | alone 0.07 iconic sights a trip, under the bar; the place-level check: in 100% of Rome trips starting on a Sunday, then in 0% | none |
| | The owner's flagship places (the Vatican Museums) score 0.06 more, unless asked for | `score.ts` `scoreParts`, `dataPolicy.ts` `FLAGSHIP_PLACES` | The owner's call: extra emphasis for the Vatican. Added after the rules were measured; the numbers are the final planner without and with it (below) | Rome trips where the Vatican Museums are open, within budget, and not asked for: 63.5% [62.3 to 65.0] include them (holiday), not 75.0%; 75.5% (mixed), not 79.6% | none past the bar: at most 0.02 fewer visits on day 1 (mixed). The Mercato Testaccio lunch, Castel Sant'Angelo, and the Palatine Hill are each in 1.2 to 1.6 points fewer holiday trips |
| Day rules | Outings (4 hours or more) start by noon | `dayLimits.ts`, `dayRules.ts` | Taste: an outing that starts at 15:00 is the whole day | binds in +8.0 [7.8 to 8.0] of trips (mixed); nothing else moves 0.1 | none |
| | Parks and outdoor experiences end by sunset | `dayRules.ts` `daylightEnd` | Fact: a park after dark is closed or unlit | binds in +15.8 [13.8 to 17.3] (holiday), +9.4 (mixed); travel +1.9 minutes a day | none |
| | Gelato and wine bars after noon | `dayRules.ts` `keepsDayRules` | Taste | binds in +15.5 [14.8 to 16.4] (mixed); nothing else moves 0.1 | none |
| | No treat right before lunch | `dayRules.ts` `keepsDayRules` | Taste | binds in +8.4 [7.6 to 9.0] (mixed); trips with a starved day +0.6 | none |
| | Aperitivo not before 17:00 | `dayRules.ts` `isEarlyAperitivo` | Taste; the name says when it happens | binds in +1.8 [1.6 to 1.9] alone, under the bar; in the final planner +1.9 to +2.2 (mixed) and +2.3 to +2.6 (must) | none |
| | Museums not on 25 December or 1 January | `dayRules.ts` `closedForHoliday` | Fact: most close, and the data's hours do not say so | binds in +85.7 [85.0 to 86.8] of holiday trips | 0.32 fewer iconic sights a holiday trip [0.29 to 0.36]: the ones it would add are mostly closed that day |
| | One trip out of town a day, left by 15:00, worth the journey | `dayRules.ts` `outOfTownAllowed` | Each trip out is an hour or more each way | binds in +18.0 [16.5 to 19.6] of thin trips, +13.3 (mixed); travel +8.6 minutes a day [8.0 to 9.2] (thin) | days missing lunch +2.7 [2.6 to 2.7] and with no meal +2.4 (thin): the lunches out of town a thin base could use. Two trips out, or a late one, cost more time than the meal saves |
| Meals | Seat a missing meal at an unused meal place | `mealFill.ts` `fillMissingMeals` | The walk can reach a meal hour with no place left on its way | days missing a meal +4.6 [4.3 to 5.1] (must), +2.4 (mixed) | none |
| | Give up a visit for a meal adding cannot seat (never a must-include, at least 2 visits kept, no new wait over an hour) | `mealFill.ts` `withMealForVisit` | Days are walked in turns, so a day can take an evening sight counting on a dinner place another day then takes (the default Rome trip: Pigneto until 20:20, then no dinner place in reach) | days missing a meal +4.64 [4.41 to 4.77] (must), +1.51 [1.28 to 1.63] (mixed), +1.29 (holiday) | 0.05 fewer visits a day (must), 0.02 (mixed); 0.07 fewer iconic sights a trip (must) |
| Schedule | A meal place that ends the day after noon waits for dinner | `schedule.ts` `lastStopStep` | A restaurant at 15:40 as the day's last stop is a dinner the traveler would come back for | days missing dinner +1.4 [1.2 to 1.5] (holiday), under the bar; kept because the same `scheduleDay` times AI plans and shared links, which the sweep does not measure | none |

**Removed after measuring.** Each item alone is under the bar on the mean of three seeds, except two that were measured with the rule they served and removed with it. The route pass's wait cap alone would lengthen waits: without the cap, days with a wait over an hour +3.6 [3.4 to 4.0] (holiday); without the pass and its cap together, travel +6.0 minutes a day [5.9 to 6.0] (mixed) and no wait change. The later-meal promise's second try alone would starve days: without it, trips with a starved day +1.5 [0.4 to 2.2] (thin), over the bar on one seed; without the promise and its second try together, no metric moves 0.2. The list, with the largest three-seed mean: the 2-opt route pass (travel +6.0 minutes a day) and its wait cap; meal sharing between days (+0.4); the second meal fill (0); the meal fill's wait cap (+0.1); the visit rescue for a day of meals only (0.1); borrowing a stop for an empty day (chosen-base trips moved +1.3, thin); a meal place as an empty day's lone visit (0); lower visit caps for thin bases (0); the must-include visit-cap exception (0); the waiting turn for a held day (0.1); the fewer-meals tie-break (0.1); the later-meal promise and its second try; the empty-day first stop (0.1); must-include urgency (0.1), slot matching (0.3), and flexible promises (0.1); the market-and-food-hall pool rule (days missing lunch +1.2, thin); no aperitivo after dinner (0); tastings by 18:00 (+0.7); the relaxed long-transfer surcharge (+0.4); the repair after the route pass and the clean-up of stops `scheduleDay` rejects (no plan changed; the validator and the API guard remain). Two of these were day rules, and they left `dayRules.ts` too, so a sweep judged by today's code cannot see them; to measure one again, judge with the planner at commit 5df0a0b.

**The route pass and the eval set.** When the rules were measured (2026-09-24, 15 eval cases), the rules-only column of the eval report (`packages/evals/results/latest.md`) showed travel rising from 94 to 103 minutes a day. That rise is the route pass alone: the final planner plans those 15 cases exactly as the original without it. On those cases the pass is worth 8.8 minutes a day (95% bootstrap interval over the cases, 6.4 to 11.0), against 6.0 on the mixed sweep; 12 of the 15 cases are balanced trips, where the sweep also gives 6.6 [6.5 to 6.7]. Both are under the 10-minute bar. The sweep governs because it is 9000 days drawn to cover the request mix, where the eval set is 45 days chosen for edge cases. The pass is the first rule to bring back for a "limit walking" or "shorter routes" ask.

**Together.** On every seed and profile, the final planner stays under the bar against the original: the largest change is 0.75 of it (trips breaking a day rule +1.5, must, seed 11). Travel rises 5.5 to 6.0 minutes a day on every profile but thin, the route pass's cost; no share moves by more than 1.5 points.

**The place-level check** (`scripts/sweepPlaces.ts`) lists every place whose share of plain trips at a chosen base, by start weekday, or whose must-include day without lunch or dinner, moved by 20 points or more. Before the two put-backs it listed the Vatican Museums on Sunday starts (100 points), Campo de' Fiori on Monday starts (67), and the Pantheon (66), Piazza Navona (58), and the Gianicolo (48) as must-includes whose day lost its lunch. On the final planner it lists two losses, both known and open:

- The Bargello in plain Florence trips: in 308 of the 364 packed ones before (every start day but Friday), in none now. The Mercato Centrale market and other sights take its place; it is a hidden gem, not an iconic sight.
- Piazza Maggiore at Night as a must-include: its day has no dinner in 31% of trips, against none before. Bologna has few dinner places, and the rule that kept a dinner for an evening must-include (must-include slot matching) was removed. Put back alone, it fixes this and costs the day of the Navigli canals at aperitivo hour its lunch in 38% of trips; the fix needs its own design and measurement.

Two cases an earlier review fixed by hand still plan differently, rare enough that no metric moves: the Parma tour asked for together with the Asinelli tower starts at 12:15 instead of 11:15, and a Bologna base thinned by seven exclusions in January spends its third day in Florence, with a warning.

| Metric (mixed profile, 3000 plans, seed 20260924) | Before | After |
|---|---|---|
| Validator errors, planner failures | 0, 0 | 0, 0 |
| Trips with a starved day (under 2 visits) | 7.0% | 6.8% |
| Visits per day (day 1, 2, 3) | 3.78, 3.61, 3.73 | 3.80, 3.61, 3.73 |
| Days missing lunch or dinner; with no meal | 25.0%; 0.8% | 25.4%; 0.9% |
| Trips with 2 bases; with a transfer over 3 h | 33.6%; 6.4% | 33.9%; 6.7% |
| Visits matching an interest | 47.6% | 47.8% |
| Travel; daytime waiting (minutes a day) | 98.1; 8.7 | 104.1; 8.8 |
| Stops starting after 22:00 | 0.13% | 0.21% |
| Must-includes placed | 76.9% | 76.9% |
| Time per plan, p50 and p95 | 4.5 ms, 8.1 ms | 3.4 ms, 6.9 ms |

2564 of the 3000 plans changed. Timings are from one sequential run on one machine. Lines in `src/*.ts` (outside `normalize/` and `validate/`): 6541 before, 5460 after, in 43 and 34 files; the walk and its passes (the trip builder, walk, picks, limits, rules, repair, meal fill, pools, and plan files, with the removed ones): 2947 to 1945; all of `src`: 10578 to 9497.

**The flagship bonus.** Measured on 2026-09-25 against the planner at commit 4320c8d, on the three seeds and four profiles of 3000 plans, and with the place-level check. The share is of Rome trips (every day at Rome) where the Vatican Museums are open on a Rome day other than 25 December or 1 January, within budget, and not a must-include. The web form's default request (balanced, no interests, bases chosen by the planner) and plain Rome trips at every pace, started on every day of a year, already had them in 100% and 99.6% of trips; both now have them in 100%, and neither misses a meal, before or after.

| Weight | Mixed | Holiday | Thin | Must | Past the bar |
|---|---|---|---|---|---|
| 0 (before) | 75.5% | 63.5% | 81.9% | 26.0% | |
| 0.05 | 77.0% | 64.2% | 84.0% | 26.8% | nothing |
| 0.06 (kept) | 79.6% | 75.0% | 85.3% | 27.6% | nothing |
| 0.07 | 79.9% | 75.1% | 85.3% | 27.9% | the book market as a must-include: its day has no lunch in 33% of trips, not 10% |
| 0.25 | 84.9% | 80.9% | 87.9% | 31.7% | from 0.08, plain Rome trips reshuffle: every packed one starting on a Sunday, and 31 of 52 starting on a Monday, misses a dinner (none before), and Castel Sant'Angelo leaves Friday-start trips (21% to 0). From 0.15 the Vatican Museums open day 1 of most plain Rome trips, the Campo de' Fiori market leaves Monday-start trips (67% to 0), and Piazza Navona is in half as many |
| 0.5 | 89.6% | 85.8% | 91.9% | 33.9% | the same as 0.25; no sweep metric passes the bar |

By start weekday at 0.06 (mixed, three seeds), the Rome trips that include them: Sunday 61.6% to 63.3%, Monday 62.7% to 68.6%, Tuesday 62.4% to 66.1%, Wednesday 63.8% to 67.4%, Thursday 57.2% to 61.9%, Friday 61.6% to 62.9%, Saturday 60.6% to 63.3%; of all trips with a Rome day, 48.8% to 52.4%. 136 to 148 of each 3000 mixed plans change. The places most often displaced from trips with a Rome day are the Mercato Testaccio lunch (the four-hour visit covers lunch), Pigneto, and Castel Sant'Angelo (mixed, 0.5 to 0.9 points of all trips each). The AI shortlist ranks its candidates with the same score (`services/api/src/plan/candidates.ts`), so the Vatican Museums move up the list the model reads, from 8th to 5th of Rome's visits for the default request; the prompt and its version are unchanged, a reordered list does not make eval recordings stale, and the eval report is unchanged.

## Bases: what the planners choose, and what a traveler may set

The whole-trip planners, the rules-only one and the AI's, use at most `MAX_ANCHORS_PER_TRIP` (2) bases and change base once at most (`planAnchors.ts`: no trip goes back and forth, and three bases in three days is mostly transit); the form offers two bases, and the API holds a whole-trip AI answer to two (`materialize.ts`). A route the traveler sets by hand on a planned trip may give every day its own city, in any order: the validator allows `MAX_BASES_PER_TRIP` (`TRIP_DAYS`, a base a day) by default. Its must-include rule still asks what a planner could have done, so a missing place of a base the route does not have stays a warning, and a place of a base the route has is judged on that base's own days, with their real windows after each transfer.

`planRoute` (`dayRoute.ts`) never refuses a city for travel. For each day it gives the city, the travel in and out, the start (the pace's start plus the travel in), the time before dinner, the facts ("2 h 10 min by high-speed train from Rome, so the day starts at 11:40.", "Leaves about 7 h before dinner."), and a note on what happens to the day. A day is planned again when its city changes, when its travel in changes and the validator finds its stops no longer fit ("Day 3 will be planned again: it now starts after 2 h 10 min of travel."), or when it must take a must-include from a day that moved, the first day of that city. Every other day keeps its stops ("Day 2 keeps its places and now starts at 10:00."). The days are planned by the rules in day order, each one seeing the days planned before it (`planDay`), and the whole trip goes through the validator; a pass that finds a kept day faulted or a must-include lost plans one more day and tries again, at most once a day. A day planned again only to hold a must-include that a day planned before it took after all is then tried once as kept, and keeps its stops when no day is empty, the trip has no error it did not have and every must-include is still in (Bologna for three days with Via Drapperie on day 1, routed Rome, Bologna, Bologna: day 2 takes it, and day 3 no longer loses its stops for nothing; 6 of 78,750 swept routes change, each by exactly this). A route is refused only when a must-include the trip has would be lost ("Day 1 has Colosseum, which you asked for, and no other day of this route is in Rome." with "Keep day 1 in Rome, or remove Colosseum from day 1 first."), when nothing fits a day after its travel ("Nothing in Milan fits day 3 after 3 h 35 min of travel."), or, as a last guard the rules never reach, when the trip would gain an error. It takes about 1 ms a route (3 new cities, measured in `test/dayRoute.test.ts`), and `dayBaseOptions` over a whole sheet about 12 ms, so both run on every tap. `routeOptions` gives each city for a day its facts as `warnings`, and the other days it touches also as `others` (`{ day, replan, note }`), so the page can say a fact once.

Measured over 84,375 routes (675 trips from every pair of bases, pace and 9 start weeks, each with all 125 routes of 5 bases, no must-includes): 28 refused, all a whole trip in one small city from a Monday in November with nothing left for one of its days (Bologna three times, 21; Milan three times at a packed pace, 7); none was refused for a new error, and of the days that kept their city while their travel changed, 16,200 were planned again and 10,530 kept their stops with a new start. Over 93,750 routes with one iconic must-include each (the Colosseum, the Uffizi, the Pantheon, Florence's Duomo square, the Rialto Bridge; random routes often leave its city out): 44,550 allowed, 49,025 refused for the must-include (1,200 of them with a day in its city that could not take it, such as the Uffizi on a Monday) and 175 for an empty day; every allowed route kept its must-include and planned to zero validator errors, and planning the same days one request at a time, as the page and the API do, gave the same days every time.

## Measuring a change

```
pnpm exec tsx packages/planner/scripts/sweep.ts                         # 3000 plans, table
pnpm exec tsx packages/planner/scripts/sweep.ts --profile thin --count 1000 --out DIR --label mine
pnpm exec tsx packages/planner/scripts/sweep.ts --seed 11 --src COPY/src --out DIR --label no-rule
pnpm exec tsx packages/planner/scripts/sweep.ts --compare DIR/baseline.json DIR/no-rule.json
pnpm exec tsx packages/planner/scripts/sweepPlaces.ts --src COPY/src --out DIR --label no-rule
pnpm exec tsx packages/planner/scripts/sweepPlaces.ts --compare DIR/baseline.json DIR/no-rule.json
```

Profiles: `mixed` (the headline mix: 1 in 5 trips over a public holiday, every pace, budgets, interests, automatic and chosen bases, must-includes, exclusions), `thin` (one chosen base starved by a low budget and 5 to 10 exclusions), `must` (4 to 10 must-includes in up to 3 bases), and `holiday` (every trip over 25 December or 1 January). A seed fixes the requests, so two runs with the same seed, profile, and count compare request by request; `--compare` refuses runs that differ in any of them, and an unknown profile stops the run. Run a change on three seeds before trusting a difference near the bar: the same removal moved days missing a meal by 1.7 on one seed and 2.5 on another. Every metric is judged by the checked-out validator and day rules, never by the copy under test. The place-level check (`sweepPlaces.ts`) plans about 16,000 fixed requests in about a minute and needs no seed.

## Data policies

- Source notes only ever make hours stricter. A wrong "open" wastes a trip; a wrong "closed" only hides an option. Notes that would extend hours are shown, not applied ([note_not_applied](data-issues.md#notes-that-would-extend-hours-note_not_applied)).
- Public spaces with no listed hours (squares, fountains, bridges, parks, viewpoints) are open access, 07:00 to 23:00 every day, and not penalized ([hours_open_access](data-issues.md#public-spaces-with-no-set-hours-hours_open_access)).
- Free-text hours become derived windows: "Evenings" is 18:00 to 24:00, "Morning only" 07:00 to 13:00 ([hours_free_text](data-issues.md#hours-estimated-from-the-listing-hours_free_text)); a time of day in the name ("by Night", "at Dawn", "Aperitivo") sets the window when no hours are listed ([hours_name_hint](data-issues.md#hours-estimated-from-the-name-hours_name_hint)).
- Anything else without hours is schedulable inside the day window, ranks lower, and carries `HOURS_UNKNOWN` ([hours_missing](data-issues.md#hours-not-confirmed-hours_missing)).
- Seasons and date rules close a place outside them ([season_restriction](data-issues.md#open-part-of-the-year-season_restriction)). Meal places are restaurants plus a reviewed list ([meal places](data-issues.md#meal-places)).

## The validator, and why it is independent

`validateItinerary` never calls the scheduler. It rebuilds each day's facts from the plan itself (`validate/days.ts`), then re-derives everything from the stop times: known ids, duplicates, exclusions, the base of each stop, hours on that date, the day window, meal windows, travel between stops with the travel model, the trip back to the base, the visit cap, both meals, and whether a missing must-include was placeable (an error) or not (a warning with the reason). It shares only the rule predicates (`constraints.ts`, `time.ts`, `travel.ts`, `config.ts`) and one severity table (`violations.ts`), not the timing walk. The scheduler builds every plan, the AI's included, so a validator that reused it would pass the scheduler's own bugs. The mutation tests corrupt valid trips one way per error code, and a property test runs the scheduler and the validator on random orders and requires them to agree.

## Extending it

| Ask | Where | Steps |
|---|---|---|
| Vegetarian filter | `dataPolicy.ts`, `types.ts` and `schemas.ts` `TripRequestSchema`, `constraints.ts` `isCandidate`, `enums.ts` and `violations.ts`, `validate/stopPlace.ts` `checkPlace`, `apps/web/components/TripForm.tsx` and `lib/tripForm.ts` | The data has no dietary field, so add a reviewed table of suitable meal places; add `vegetarian` to the request; drop unsuitable meal places in `isCandidate` (the pools, swaps, and the AI shortlist all call it); add a warning code and check it in the validator; add a checkbox. |
| Four days | `config.ts` `TRIP_DAYS` | One line changes the trip; the planner, the validator, and the property tests follow it (`test/validate/tripLength.ts` fits the fixtures). Twelve example tests pin three-day plans and fail at four days, in `budget`, `mealFill`, `plan`, `planMustInclude`, `tripBuilder`, `tripWalk`, and `validate/mustInclude`; some are quality guards (dinner in Venice, a budget traveler's meals), so check each plan rather than re-pinning it, then rerun the sweep and the place-level check to see what a fourth day does to the metrics. Update the "3 Days" copy in `apps/web`. As a request field: `TripRequest.days`, `tripDates(startDate, days)` in `plan.ts`, `checkTripShape` in `validate.ts`, the model schema in `services/api/src/llm/schema.ts`, `DayTabs.tsx`. |
| Start from a hotel | `anchors.ts` `dayOrigin`, `types.ts`, `schemas.ts`; `apps/web/lib/timetable.ts`; `services/api/src/plan/candidates.ts` | Add `hotels?: Record<baseId, LatLng>` to the request and `TripRequestSchema`; return the hotel from `dayOrigin`. In the planner that is all: the scheduler, look-ahead, validator, scoring, and swaps already call `dayOrigin`. Outside it, two places still use the base centroid: the timetable's first and last legs (`legFor` and `returnFor` pick the travel mode from `anchor.centroid` and say "from central Rome"), and the AI shortlist's ranking (`candidatesFor` scores from `anchor.centroid`; pass `dayOrigin(anchor, request)`). Add a form field, and decide whether share links carry the hotel: the request travels in the link, while notes are stripped as private. |
| Indoor day for rain | `constraints.ts`, `tripWalk.ts` `buildTrip` | Add `isIndoor(place)` from the type and the `rainy-day` tag; add `rainDays` to the request; filter that day's pool where the holiday filter is; skip `rescueEmptyDay` (public spaces are outdoors); optionally a validator warning. |
| Limit walking | `config.ts` `TRAVEL.walkMaxKm`, `travel.ts` `travelModeForKm`, `legMode` | Globally, one number. Per request, pass the limit into `travelMinutes`, `travelMode`, and `travelLeg` and through every caller (grep them). The planner's calls (`schedule.ts`: `timeStep`, `lastStopStep`, and the trip back in `scheduleDay`; `dayLimits.ts`; `dayPicks.ts`; `tripWalk.ts` through `timeStep`; `anchors.ts` `transferMinutes`) and the validator's (`validate/stops.ts`, `validate/dayTotals.ts` `checkReturn`, `validate/days.ts`, and the four in `validate/mustIncludeFit.ts`) must change together, or every plan fails with `WRONG_TRAVEL` and must-includes are judged placeable on the wrong times. The labels follow from `travelMode` (`reasons.ts`, `apps/web/lib/timetable.ts`). Bringing back the removed route pass is the other half of this ask. |
| Lock a stop and replan the day | new `replan.ts`, `apps/web/lib/itineraryReducer.ts` | Pool from `new PoolCache(request, ctx).strict(base)` minus places on other days; `buildDay({ ..., obligations: new Set(locked) })` from `dayBuilder.ts`; time and re-validate with `rescheduleDay`. Locked stops are must-includes for that day. |
| Calendar export | new `ics.ts` `toIcs(itinerary, ctx)`, `index.ts`, a button beside `ShareButton.tsx` | One VEVENT per stop with `TZID=Europe/Rome` from `day.date` and `stop.start`/`end`; the web app downloads it as a `text/calendar` Blob. |
| Daily cost | `config.ts`, new `cost.ts` `dayCost(day, ctx)`, `DayTimetable.tsx` | A euro range per price level; sum per day; count unknown prices separately; show under the day header. |
| Prefer quiet | `config.ts` `SCORE_WEIGHTS`, `score.ts` `scoreParts` | One weight and one term (the `quiet` tag up, `tourist-heavy` down) when the request asks for it. |
| Why was a place not chosen | new `whyNot.ts`, reuse `constraints.ts` and `validate/mustInclude.ts` `placeability` | Return the first failing rule: not in the data, excluded, base not in the trip, rating, budget (`isCandidate`), closed on every trip day (`hoursOn`); else ask `placeability` as if it were a must-include; if it fits, it lost on score (`scoreParts`). |
