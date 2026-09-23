#!/usr/bin/env bash
# Post-deploy smoke test for the live site. Runs every check, then fails if any failed.
#
# Env: SITE_URL, SHA (the commit that must be live), WEB_BUCKET, HTTP_API_URL (the direct
# execute-api URL), AWS_REGION (default us-east-1), SMOKE_PLAN_CHECK ("true" to also plan a trip).
# Optional GITHUB_OUTPUT receives version=<api version>, GITHUB_STEP_SUMMARY a table of results.
# Also runs by hand: SITE_URL=https://stripe.brdjx.com SHA=<sha> ... .github/scripts/smoke-test.sh
set -uo pipefail

: "${SITE_URL:?}" "${SHA:?}"
AWS_REGION="${AWS_REGION:-us-east-1}"
host="${SITE_URL#https://}"
host="${host%%/*}"
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
check_health() {
  local body="" attempt
  for attempt in $(seq 1 12); do
    body="$(curl -sS --max-time 10 --fail "${SITE_URL}/api/health" 2>/dev/null || true)"
    if jq -e --arg sha "$SHA" '.ok == true and .commit == $sha' <<<"$body" >/dev/null 2>&1; then
      # The body is untrusted: only a short plain version string is passed on.
      local version
      version="$(jq -r '.version | tostring' <<<"$body")"
      [[ "$version" =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || version="invalid"
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "version=${version}" >>"$GITHUB_OUTPUT"
      record pass "health reports this commit" "attempt ${attempt}, version ${version}"
      return
    fi
    echo "health attempt ${attempt}: not yet serving ${SHA}"
    sleep 15
  done
  record fail "health reports this commit" "never saw ok=true and commit=${SHA}"
}

expect_status() { # expect_status <check> <want> <curl args...>
  local check="$1" want="$2" got
  shift 2
  got="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || echo 000)"
  if [ "$got" = "$want" ]; then record pass "$check" "$got"; else record fail "$check" "got ${got}, want ${want}"; fi
}

check_redirect() {
  local out code location
  out="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://${host}/" || true)"
  code="${out%% *}"
  location="${out#* }"
  if [[ "$code" =~ ^30[18]$ && "$location" == "https://${host}/"* ]]; then
    record pass "HTTP redirects to HTTPS" "$code"
  else
    record fail "HTTP redirects to HTTPS" "got '${out}'"
  fi
}

check_headers() {
  local headers missing=()
  headers="$(curl -sS -D - -o /dev/null --max-time 10 "${SITE_URL}/" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  grep -q '^strict-transport-security: .*max-age=[1-9]' <<<"$headers" || missing+=(hsts)
  grep -q '^content-security-policy: ' <<<"$headers" || missing+=(csp)
  grep -q '^x-content-type-options: nosniff' <<<"$headers" || missing+=(x-content-type-options)
  grep -q '^referrer-policy: ' <<<"$headers" || missing+=(referrer-policy)
  # Either header stops the site being framed.
  grep -qE '^x-frame-options: |^content-security-policy: .*frame-ancestors' <<<"$headers" ||
    missing+=(frame-protection)
  if [ "${#missing[@]}" -eq 0 ]; then
    record pass "security headers on /" "all present"
  else
    record fail "security headers on /" "missing ${missing[*]}"
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

check_health
expect_status "index page" 200 --retry 3 "${SITE_URL}/"
check_redirect
check_headers
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
