#!/usr/bin/env bash
# Post-deploy smoke test for the live site and the public API host. Runs every check, then
# fails if any failed.
#
# Env: SITE_URL (the web app, which calls /api on the same host), API_URL (the public API host,
# paths without /api), SHA (the commit that must be live), WEB_BUCKET, HTTP_API_URL (the direct
# execute-api URL), AWS_REGION (default us-east-1), SMOKE_PLAN_CHECK ("true" to also plan a trip).
# Optional GITHUB_OUTPUT receives version=<api version>, GITHUB_STEP_SUMMARY a table of results.
# Also runs by hand: SITE_URL=https://italy-planner.brdjx.com
#   API_URL=https://api.italy-planner.brdjx.com SHA=<sha> ... .github/scripts/smoke-test.sh
set -uo pipefail

: "${SITE_URL:?}" "${API_URL:?}" "${SHA:?}"
SITE_URL="${SITE_URL%/}"
API_URL="${API_URL%/}"
AWS_REGION="${AWS_REGION:-us-east-1}"
results=()
failed=0

record() { # record <pass|fail> <check> <detail>
  results+=("| $2 | $1 | $3 |")
  if [ "$1" = "fail" ]; then
    failed=1
    echo "::error::smoke: $2: $3"
  else
    echo "ok: $2 ($3)"
  fi
}

# Decision: 12 attempts 15 s apart (3 minutes) covers a Lambda cold start plus edge propagation.
# The check is strict: the live API must report this exact commit, not just answer.
check_health() { # check_health <check> <url> [output-version]
  local check="$1" url="$2" output_version="${3:-}" body="" attempt
  for attempt in $(seq 1 12); do
    body="$(curl -sS --max-time 10 --fail "$url" 2>/dev/null || true)"
    if jq -e --arg sha "$SHA" '.ok == true and .commit == $sha' <<<"$body" >/dev/null 2>&1; then
      # The body is untrusted: only a short plain version string is passed on.
      local version
      version="$(jq -r '.version | tostring' <<<"$body")"
      [[ "$version" =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || version="invalid"
      if [ -n "$output_version" ] && [ -n "${GITHUB_OUTPUT:-}" ]; then
        echo "version=${version}" >>"$GITHUB_OUTPUT"
      fi
      record pass "$check" "attempt ${attempt}, version ${version}"
      return
    fi
    echo "${check}: attempt ${attempt} not yet serving ${SHA}"
    sleep 15
  done
  record fail "$check" "never saw ok=true and commit=${SHA}"
}

expect_status() { # expect_status <check> <want> <curl args...>
  local check="$1" want="$2" got
  shift 2
  got="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || echo 000)"
  if [ "$got" = "$want" ]; then record pass "$check" "$got"; else record fail "$check" "got ${got}, want ${want}"; fi
}

check_redirect() { # check_redirect <check> <https url>: its http:// twin must redirect to it
  local check="$1" url="$2" out code location
  out="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://${url#https://}" || true)"
  code="${out%% *}"
  location="${out#* }"
  if [[ "$code" =~ ^30[18]$ && "$location" == "$url"* ]]; then
    record pass "$check" "$code"
  else
    record fail "$check" "got '${out}'"
  fi
}

check_headers() { # check_headers <check> <url>
  local check="$1" url="$2" headers missing=()
  headers="$(curl -sS -D - -o /dev/null --max-time 10 "$url" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  grep -q '^strict-transport-security: .*max-age=[1-9]' <<<"$headers" || missing+=(hsts)
  grep -q '^content-security-policy: ' <<<"$headers" || missing+=(csp)
  grep -q '^x-content-type-options: nosniff' <<<"$headers" || missing+=(x-content-type-options)
  grep -q '^referrer-policy: ' <<<"$headers" || missing+=(referrer-policy)
  # Either header stops the site being framed.
  grep -qE '^x-frame-options: |^content-security-policy: .*frame-ancestors' <<<"$headers" ||
    missing+=(frame-protection)
  if [ "${#missing[@]}" -eq 0 ]; then
    record pass "$check" "all present"
  else
    record fail "$check" "missing ${missing[*]}"
  fi
}

check_plan() {
  local start request status
  start="$(date -u -v+30d +%F 2>/dev/null || date -u -d '+30 days' +%F)"
  request="$(jq -nc --arg start "$start" '{startDate: $start, pace: "balanced",
    interests: ["historic"], maxPriceLevel: null, anchors: "auto", mustInclude: [], exclude: []}')"
  status="$(curl -sS -o "${TMPDIR:-/tmp}/smoke-plan.json" -w '%{http_code}' --max-time 29 \
    -X POST -H "content-type: application/json" --data "$request" \
    "${SITE_URL}/api/plan?mode=deterministic" || echo 000)"
  if [ "$status" = "200" ] && jq -e '(.days | length) == 3 and .source == "deterministic"
      and all(.days[]; (.stops | length) > 0)
      and ([.warnings[]? | select(.severity == "error")] | length) == 0' \
      "${TMPDIR:-/tmp}/smoke-plan.json" >/dev/null 2>&1; then
    record pass "deterministic plan" "3 days with stops, no errors"
  else
    record fail "deterministic plan" "status ${status}, body did not have 3 valid days"
  fi
}

# The site's /api/* and the API host reach the same function through two distributions, so both
# must report the new commit. The version output comes from the site check.
check_health "site /api/health reports this commit" "${SITE_URL}/api/health" output-version
check_health "API host /health reports this commit" "${API_URL}/health"
expect_status "index page" 200 --retry 3 "${SITE_URL}/"
check_redirect "site redirects HTTP to HTTPS" "${SITE_URL}/"
check_redirect "API host redirects HTTP to HTTPS" "${API_URL}/health"
check_headers "security headers on the site" "${SITE_URL}/"
check_headers "security headers on the API host" "${API_URL}/health"
# The API only answers through CloudFront (origin-verify header); the bucket only through OAC.
if [ -n "${HTTP_API_URL:-}" ]; then
  expect_status "direct execute-api URL refused" 403 "${HTTP_API_URL%/}/api/health"
else
  record fail "direct execute-api URL refused" "no HTTP_API_URL (SAM output HttpApiUrl)"
fi
if [ -n "${WEB_BUCKET:-}" ]; then
  expect_status "direct S3 object URL refused" 403 \
    "https://${WEB_BUCKET}.s3.${AWS_REGION}.amazonaws.com/index.html"
else
  record fail "direct S3 object URL refused" "no WEB_BUCKET (Terraform output web_bucket_name)"
fi
# Opening a trip that does not exist reads the trips table: 404 proves the table and the
# function's rights on it (the bootstrap boundary and the template's policy); 503 means the store
# failed. Read only, so no deploy ever writes a trip. Any 10-character id works; this one is
# never issued in practice (ids are random base62).
expect_status "trips table answers (unknown trip is 404)" 404 "${API_URL}/trips/0000000000"
if [ "${SMOKE_PLAN_CHECK:-}" = "true" ]; then check_plan; fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Smoke test"
    echo ""
    echo "| Check | Result | Detail |"
    echo "|---|---|---|"
    printf '%s\n' "${results[@]}"
  } >>"$GITHUB_STEP_SUMMARY"
fi
exit "$failed"
