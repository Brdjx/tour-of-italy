# Deploy

## Overview

The web app runs at https://italy-planner.brdjx.com and the public API at
https://api.italy-planner.brdjx.com, in AWS account 388773186626, region us-east-1. The account is
shared with other production stacks. CI can reach only this project's resources: those named
`italy-planner-*`, and, for resources AWS names with generated ids (the HTTP API, the two
CloudFront distributions, the origin access control and headers policy, the certificate), exactly
the ids pinned after the first deploy. A few read-only calls have no resource scope; see
[What CI can reach](#what-ci-can-reach).

```
browser -> CloudFront site distribution (italy-planner.brdjx.com)
             /*      -> S3 bucket italy-planner-web-388773186626 (private, origin access control)
             /api/*  -> HTTP API italy-planner-api -> Lambda italy-planner-api
                                                        -> DynamoDB table italy-planner-trips

smoke test, scripts, tools -> CloudFront API distribution (api.italy-planner.brdjx.com)
             /*      -> the same HTTP API with origin path /api (/health reaches /api/health)

Both distributions: one WAF web ACL, one security headers policy, one certificate for both
names, and the x-origin-verify header (the function answers 403 to calls without it).
```

### Why two hostnames

The web app stays same-origin: it calls `/api/*` on its own host, so there is no CORS preflight,
the CSP needs no second host (`connect-src 'self'`; the map's tiles are served from the site too), and one WAF path covers
every browser call. The public API host serves the post-deploy smoke test, curl and scripts, and
future tool clients with plain paths (`/health`, `/meta`, `/places`, `/data-issues`, `POST /plan`,
`POST /trips`, `GET /trips/<id>`)
through the same WAF rules and the same origin secret, so it opens no way around either. It sends
no CORS headers, so it is not meant for other websites. The evals use neither host: they run the
production pipeline in-process.

```sh
curl -s https://api.italy-planner.brdjx.com/health
curl -s -X POST -H 'content-type: application/json' --data @request.json \
  'https://api.italy-planner.brdjx.com/plan?mode=deterministic'
```

Paths on the API host have no `/api` prefix: CloudFront adds it, so
`https://api.italy-planner.brdjx.com/api/health` reaches the function as `/api/api/health` and gets
the JSON 404. Plain HTTP to the API host is redirected to HTTPS, which suits a browser or a `GET`;
a `POST` over HTTP arrives without its body, so clients must use `https://`. The WAF plan limit
counts `/api/plan` on the site, `/plan` on the API host and any path ending in `/plan` (so a
leading `/../` cannot dodge it), and the AWS common rule set blocks requests without a
`User-Agent` header (curl and most HTTP libraries send one).

| Layer | Path | Applied by | State |
|---|---|---|---|
| Bootstrap: CI roles, permissions boundary, SAM artifacts bucket, budget | `infra/terraform/bootstrap` | an admin | `fortissimo-terraform-state`, `tour-of-italy/bootstrap.tfstate` |
| API: Lambda, HTTP API, trips table, log group, alarms | `infra/sam` (stack `italy-planner-api`) | an admin once, then CI | CloudFormation |
| Platform: certificate, DNS, web bucket, both CloudFront distributions, WAF, origin secret | `infra/terraform/platform` | an admin once, then CI | `tour-of-italy/platform.tfstate` |

CI updates; an admin creates. The deploy role cannot create or delete the HTTP API, either
distribution, the origin access control, headers policy or certificate, cannot change its own
roles or policies, and every role it creates carries the `italy-planner-boundary` permissions
boundary, which only works for the `italy-planner-api` function's own code.

## GitHub plan

The repository is private on GitHub Free. Branch protection, rulesets, environment variables and
environment protection rules are not available (`gh api repos/Brdjx/tour-of-italy/branches/main/protection`
answers 403 "Upgrade to GitHub Pro"). So every variable is a repository variable, and the AWS trust
policies are the guard: the deploy role accepts only `deploy.yml` running from `main`, and the
plan role only `ci.yml` running for a pull request, in both cases only for runs started by
GitHub account 8014925 (`github_actor_ids` in the bootstrap). `ci-ok` is not enforced: merge only
green pull requests. After an upgrade to Pro, add branch protection with the required check
`ci-ok` (app id 15368) and `enforce_admins`.

## Prerequisites

- AWS CLI v2 with the `fortissimo` profile (admin rights for the bootstrap and the first deploy).
- Terraform 1.11 or newer (CI pins 1.16.3), SAM CLI 1.166.2, Node 24 and pnpm 12.6, `jq`.
- Python 3.11 or newer on `PATH` for `.github/scripts/read-samconfig.py` (macOS `/usr/bin/python3`
  is 3.9; use `PATH="/opt/homebrew/bin:$PATH"`).
- `gh` authenticated as the repository owner, and an Anthropic API key.

## One-time admin steps

Run everything from the repository root with `export AWS_PROFILE=fortissimo AWS_REGION=us-east-1`.

1. Check the account, the OIDC subject prefix (the roles trust `repo:Brdjx@8014925/tour-of-italy@1383701312:...`;
   set `github_subject_prefix` if it differs) and your account id (must be in `github_actor_ids`).

   ```sh
   aws sts get-caller-identity --query Account --output text        # 388773186626
   gh api repos/Brdjx/tour-of-italy/actions/oidc/customization/sub  # sub_claim_prefix
   gh api user --jq .id                                             # 8014925
   ```

2. Store the Anthropic key in SSM and as the eval secret. The key is read from the terminal, never
   passes through a command line, and the request file is `0600` and deleted.

   ```sh
   bash <<'EOF'
   set -euo pipefail
   umask 077
   tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
   IFS= read -rs -p "Anthropic API key: " key </dev/tty; echo
   printf '%s' "$key" | jq -Rs '{Name: "/italy-planner/anthropic-api-key", Type: "SecureString",
     Value: ., Description: "Anthropic API key for italy-planner-api",
     Tags: [{Key: "Project", Value: "italy-planner"}]}' > "$tmp"
   aws ssm put-parameter --region us-east-1 --cli-input-json "file://$tmp" --query Version --output text
   printf '%s' "$key" | gh secret set ANTHROPIC_API_KEY --repo Brdjx/tour-of-italy
   EOF
   ```

   To replace the key later, run the same block with `Overwrite: true` instead of `Tags` (SSM does
   not accept both). New function instances pick it up at their next cold start.

3. Apply the bootstrap. The plan must show only creates, all `italy-planner-*` (21 today), and the
   warning "Some deployed resource ids are empty", which stays until step 7.

   ```sh
   terraform -chdir=infra/terraform/bootstrap init
   terraform -chdir=infra/terraform/bootstrap plan -out=bootstrap.tfplan
   terraform -chdir=infra/terraform/bootstrap apply bootstrap.tfplan
   ```

4. Activate the `Project` cost allocation tag so the budget sees this project's spend (account-wide
   billing setting; other stacks' `Project` tags also become filterable). Until then it reads $0.

   ```sh
   aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active
   ```

5. Set `gh variable set AWS_REGION --repo Brdjx/tour-of-italy --body us-east-1`. Leave the role
   variables unset until step 8, so no automatic deploy races the manual one (until then the deploy
   job stops at its configuration check and the plan job is skipped).

6. First deploy, by hand, from a commit on `main` that includes the API's origin check (without
   it the smoke test's direct execute-api check fails and `/api` is reachable around the WAF).
   The check must answer 403, not crash, while `/italy-planner/origin-verify-secret` does not
   exist yet: on a first deploy the platform creates it after `sam deploy`.

   ```sh
   export PATH="/opt/homebrew/bin:$PATH" SHA="$(git rev-parse origin/main)" && git checkout "$SHA"
   pnpm install --frozen-lockfile && pnpm --filter @italy/api build
   bash .github/scripts/deploy-api.sh                        # prints http_api_url
   terraform -chdir=infra/terraform/platform init
   terraform -chdir=infra/terraform/platform plan            # review: creates only, two distributions
   bash .github/scripts/apply-platform.sh                    # prints web_bucket_name, distribution_id
   NEXT_PUBLIC_API_BASE="" pnpm --filter @italy/web build
   WEB_BUCKET=<web_bucket_name> DISTRIBUTION_ID=<distribution_id> bash .github/scripts/publish-web.sh
   SITE_URL=https://italy-planner.brdjx.com API_URL=https://api.italy-planner.brdjx.com \
     WEB_BUCKET=<web_bucket_name> HTTP_API_URL=<http_api_url> bash .github/scripts/smoke-test.sh
   aws logs describe-log-streams --log-group-name /aws/lambda/italy-planner-api --max-items 1
   ```

   The platform apply waits for certificate validation (one record per host name) and the
   rollout of both distributions (10 to 20 minutes). A passing `/api/health` through the site,
   `/health` through the API host and a log stream prove the boundary lets the function read its
   parameter and write logs. Confirm the alarm subscription email.

7. Pin the six generated ids (the HTTP API, the site and API host distributions, the origin
   access control, the headers policy and the certificate), so the CI roles can reach exactly
   these resources. Commit the file.

   ```sh
   api_id="$(aws cloudformation describe-stacks --stack-name italy-planner-api \
     --query "Stacks[0].Outputs[?OutputKey=='HttpApiId'].OutputValue" --output text)"
   terraform -chdir=infra/terraform/platform output -json | jq -r --arg api "$api_id" '
     "http_api_id = \"\($api)\"", "distribution_id = \"\(.distribution_id.value)\"",
     "api_distribution_id = \"\(.api_distribution_id.value)\"",
     "origin_access_control_id = \"\(.origin_access_control_id.value)\"",
     "response_headers_policy_id = \"\(.response_headers_policy_id.value)\"",
     "certificate_id = \"\(.certificate_arn.value | split("/") | last)\""' \
     > infra/terraform/bootstrap/deployed-ids.auto.tfvars
   terraform fmt infra/terraform/bootstrap/deployed-ids.auto.tfvars
   terraform -chdir=infra/terraform/bootstrap plan -out=bootstrap.tfplan  # 3 policies updated in place
   terraform -chdir=infra/terraform/bootstrap apply bootstrap.tfplan
   terraform -chdir=infra/terraform/bootstrap output unpinned_resource_ids  # []
   ```

8. Turn CI on and prove the deploy role end to end with one run:

   ```sh
   out() { terraform -chdir=infra/terraform/bootstrap output -raw "$1"; }
   gh variable set AWS_DEPLOY_ROLE_ARN --repo Brdjx/tour-of-italy --body "$(out deploy_role_arn)"
   gh variable set AWS_PLAN_ROLE_ARN --repo Brdjx/tour-of-italy --body "$(out plan_role_arn)"
   gh workflow run deploy.yml --repo Brdjx/tour-of-italy --ref main
   ```

   If the run fails at "Configure AWS credentials", CloudTrail shows the token's subject:
   `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity --max-results 5`
   (`userIdentity.userName`). The deploy role accepts `...:environment:production` and
   `...:ref:refs/heads/main`, and also requires `ref`, `job_workflow_ref` and `actor_id`.
   Optional: `gh variable set SMOKE_PLAN_CHECK --repo Brdjx/tour-of-italy --body true`.

## How CI/CD takes over

- Pull request: `ci.yml` runs lint, typecheck, tests, the infra checks (`terraform test`, tflint,
  `sam validate --lint`, trivy, `check-infra-contract.py`) and posts a Terraform plan made with the
  read-only plan role (only for runs started by `github_actor_ids`; others skip the plan).
- Push to `main`: when CI passes, `deploy.yml` builds without credentials, then the `production`
  job assumes the deploy role and runs `deploy-api.sh`, `apply-platform.sh`, `publish-web.sh` and
  `smoke-test.sh`. The smoke test requires `/api/health` on the site and `/health` on the API host
  to report the new commit, HTTPS redirects and security headers on both hosts, 403 from both
  the direct execute-api URL and the direct S3 URL, and 404 for an unknown saved trip on the API
  host (the function read the trips table; 503 means it could not).
- An automatic deploy only moves production forward (`deploy-guard.sh`), so re-running an old
  CI run never rolls back by accident.
- A change that would replace a pinned resource (for example a new certificate domain) fails in
  CI with AccessDenied before anything is deleted. Apply it by hand as in step 6, then repeat step 7.
- To change a host name, set `site_domain` or `api_domain` in both `infra/terraform/bootstrap` and
  `infra/terraform/platform` (`infra/test/hostnames.test.ts` fails if they differ), plus
  `SITE_URL` or `API_URL` in `deploy.yml`. Apply the bootstrap first (the deploy role's Route 53
  rights follow the names), then the platform by hand (the certificate is replaced), then step 7.

## Saved trips table

Copy link saves the trip on the server and copies a short link (`?t=<id>`). The API keeps three
kinds of record in one DynamoDB table, `italy-planner-trips` (`TripsTable` in
`infra/sam/template.yaml`): the AI content of each AI plan (90 days, key `plan#<planId>`), each
saved trip (a year, key `trip#<id>`), and AI plans cached for the options they answer (7 days,
key `cache#<hash>`, never for a request with notes). Each item is `pk`, the record as JSON text in
`body`, and `expiresAt` in epoch seconds, which the table's time to live uses. The table bills per
request, has point-in-time recovery, and is encrypted at rest with DynamoDB's AWS owned key. Its
`DeletionPolicy` and `UpdateReplacePolicy` are `Retain` and deletion protection is on, so no
template change, `sam delete` or stray `delete-table` removes saved trips
(`check-infra-contract.py` fails CI if any of the three goes). The function gets `TRIPS_TABLE`
and may call only `dynamodb:GetItem` and `dynamodb:PutItem` on that table; it never queries,
scans, updates or deletes. `POST /api/trips` has its own gateway route and throttle (2 a second,
burst 10); opening a trip stays on the proxy route with the other reads. The WAF has no rule of
its own for `/api/trips` yet, only its overall per-IP limit: adding one in
`infra/terraform/platform/waf.tf` is a follow-up. That rule has to match every spelling of the
path that reaches the handler, not only the literal one: the path is percent-decoded before the
function routes it, so `POST /api/trip%73` is saved like `POST /api/trips` (seen in review). Match
it as the plan limit does, on `uri_path` after `URL_DECODE`, `NORMALIZE_PATH_WIN` and `LOWERCASE`,
and for both hosts (`/api/trips` on the site, `/trips` on the API host, and any path ending in
`/trips`), and test it with an encoded path before relying on it.

IAM changes in `infra/terraform/bootstrap`:

- the deploy role (`deploy-api.tf`, statement `ProjectTables`) may create, update, describe
  and tag tables named `italy-planner-*` in this account and region, set their time to live and
  point-in-time recovery, and make the three read calls CloudFormation's table handler makes
  after each change (`DescribeContributorInsights`, `DescribeKinesisStreamingDestination`,
  `GetResourcePolicy`). Deletion protection is a `CreateTable` and `UpdateTable` setting, so it
  needs nothing more. It gets no item rights and cannot delete a table: CI cannot read, write
  or remove saved trips.
- the permissions boundary (`boundary.tf`, statement `ReadAndWriteProjectTables`) allows
  `GetItem` and `PutItem` on those tables, only from the `italy-planner-api` function's own code
  (`lambda:SourceFunctionArn`), like its parameter reads.

The bootstrap change is applied once by an admin before the API deploy that adds the table.
CI cannot apply the bootstrap, and without it the stack update fails with AccessDenied on
`dynamodb:CreateTable`:

```sh
terraform -chdir=infra/terraform/bootstrap plan -out=bootstrap.tfplan  # 2 policies updated in place
terraform -chdir=infra/terraform/bootstrap apply bootstrap.tfplan
```

Then merge; the deploy creates the table. Because the table is retained, a deploy that creates
it and then rolls back leaves it behind, and the next deploy fails because the name is taken.
Turn off its deletion protection and delete the empty table by hand, then deploy again:

```sh
aws dynamodb update-table --table-name italy-planner-trips --no-deletion-protection-enabled
aws dynamodb delete-table --table-name italy-planner-trips
```
 If the table exists but the function cannot use it (the boundary was not
applied), plans still work without a `planId`, Copy link falls back to the `?p=` link, the
`italy-planner-api-trip-store` alarm fires, and the smoke test's saved-trip check fails with 503.

## Roll back

1. Make sure nothing is running or waiting (GitHub keeps only the newest waiting deploy):
   `for s in queued waiting in_progress; do gh run list --repo Brdjx/tour-of-italy --status "$s"; done`
2. Deploy the last good commit (it must be on `main`) and watch it:

   ```sh
   gh workflow run deploy.yml --repo Brdjx/tour-of-italy --ref main -f ref=<sha>
   gh run watch --repo Brdjx/tour-of-italy "$(gh run list --repo Brdjx/tour-of-italy \
     --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

3. Then revert the bad change on `main` with a pull request. The rollback deploy runs today's
   deploy scripts against the old commit's code and infra, and the next push moves forward again.

If the very first stack creation fails (`ROLLBACK_COMPLETE`), run
`sam delete --stack-name italy-planner-api --region us-east-1` as an admin before retrying.

## Rotate the origin-verify secret

Change the default of `origin_secret_rotation` in `infra/terraform/platform/variables.tf` (for
example to today's date) and merge. The deploy writes a new value to SSM and to the
`x-origin-verify` header of both distributions. Until both edge rollouts finish and the function's
parameter cache expires (a few minutes), some `/api` calls on the site and some calls to the API
host get 403, so rotate at a quiet time. A `-var` applied
without a commit would be undone, with yet another secret, by the next deploy.

## Tear down

As an admin, platform first (it reads the SAM stack's output). Empty the web bucket, including
old versions and delete markers (`aws s3api list-object-versions`, then `delete-objects`, at most
1000 keys per call), then run `terraform -chdir=infra/terraform/platform destroy` (both
distributions),
`sam delete --stack-name italy-planner-api --region us-east-1` (from `infra/sam`),
`aws dynamodb update-table --table-name italy-planner-trips --no-deletion-protection-enabled`
then `aws dynamodb delete-table --table-name italy-planner-trips` (the stack retains the table,
with every saved trip, and protects it from deletion) and `aws ssm delete-parameter --name /italy-planner/anthropic-api-key`. Empty
`italy-planner-artifacts-388773186626` the same way, destroy the bootstrap, delete
`deployed-ids.auto.tfvars`, and remove the GitHub variables and the `ANTHROPIC_API_KEY` secret.

## What CI can reach

Everything in the CI policies is scoped to `italy-planner` names, the SAM stack, the state key or
the pinned ids, except these read-only statements, for which AWS offers no resource scope. They
return account-wide metadata (names, configuration, policy documents), never parameter values,
object contents or log events. `terraform test` fails if a new unscoped allow appears.

| Statement | Role | Calls |
|---|---|---|
| `TemplateChecks` | deploy | `cloudformation:ValidateTemplate`, `GetTemplateSummary` |
| `DescribeWithoutResourceScope` | deploy | log group names, log resource policies (the log group read handler needs them), alarm definitions |
| `SsmDescribe`, `ConfigReadWithoutResourceScope` | both | parameter names and descriptions, certificate and web ACL names |
| `ReadWithoutResourceScope` | deploy | certificate and web ACL names, AWS managed WAF rule groups |
| `PlatformStateList` | both | key names in `fortissimo-terraform-state` (a first run needs an unprefixed list) |

Known exposures, accepted:

- The plan role can read the origin-verify secret: `terraform plan` refreshes the SSM parameter
  and the distribution config, and the state holds it too. Pull request code runs with the plan
  role, so every account in `github_actor_ids` is trusted with the secret (pressing "Update
  branch" on someone else's pull request starts a run as you). With the secret a caller can reach
  the execute-api URL around the WAF; reserved concurrency (10) and API throttling (plan calls 1
  per second, burst 6) still cap Claude spend.
- Whoever can deploy can ship code that reads the Anthropic key. Only `deploy.yml` on `main`,
  started by `github_actor_ids`, can assume the deploy role.

## Costs

At demo traffic the AWS bill is about $10 to $13 a month, almost all of it the WAF ($5 per web
ACL plus $1 per rule, five rules, plus $0.60 per million requests). One web ACL protects both
distributions, and a CloudFront distribution has no fixed monthly cost, so the API host adds only
its requests. Seven alarms cost $0.80 (the model failures alarm reads two metrics). The API's six
custom metrics cost at most $1.80, since CloudWatch bills them only for hours that receive data.
The trips table costs cents: on-demand reads and writes of a few KB each, storage at $0.25 per
GB-month, and point-in-time recovery at $0.20 per GB-month (a year of saved trips at a few KB each
stays well under a GB). Plan records now last 90 days and cached plans 7, a few KB each; a cache
read on every AI plan request is a fraction of a cent per thousand plans, and each hit saves a
model call. The save route's throttle caps a flood at about 170,000 trips a day.
Lambda, the HTTP API ($1 per million requests), CloudFront, S3 and the CloudFront function add
cents. The certificate and SSM standard parameters are free; the brdjx.com zone already exists.
The budget `italy-planner-monthly` (default $20) emails at 80% actual and 100% forecast. Claude API
usage is billed by Anthropic, not AWS; it is capped by reserved concurrency (10), API throttling
(plan calls 1 per second, burst 6), the WAF plan limit (30 per IP per 5 minutes) and the plan
cache (the tab, the instance, the table). Both distributions share one web ACL and one rate rule, so one IP most likely has one count
across both hosts, but AWS does not document that; at worst each host counts 30 separately.

## Map tiles

The map's basemap is one file, `tiles/italy-<date>.pmtiles` (about 140 MB), in the site bucket. It is not built by CI and not in git: `publish-web.sh` excludes `tiles/*` from its delete, so it stays across deploys.

To rebuild it (new Protomaps data, or the trip's areas changed):

```sh
scripts/map-tiles/build-tiles.sh 20260924 /path/to/pmtiles   # a date from https://build-metadata.protomaps.dev/builds.json
```

Then point `TILES_PATH` in `apps/web/lib/mapStyle.ts` at the new file and upload it once, before the deploy that uses it:

```sh
aws s3 cp apps/web/public/tiles/italy-<date>.pmtiles \
  "s3://$(terraform -chdir=infra/terraform/platform output -raw web_bucket_name)/tiles/italy-<date>.pmtiles" \
  --content-type application/octet-stream --cache-control "public,max-age=31536000,immutable"
```

The old file stays in the bucket until someone deletes it by hand.
