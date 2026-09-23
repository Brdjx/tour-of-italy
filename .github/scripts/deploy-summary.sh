#!/usr/bin/env bash
# Write the production deploy summary table to the job summary.
#
# Env: STEPS (toJSON(steps) from the deploy job), JOB_STATUS, TRIGGER, SHA, SITE_URL,
# GITHUB_STEP_SUMMARY. Runs with if: always(), so every value may be missing.
set -euo pipefail

steps="${STEPS:-}"
if [ -z "$steps" ]; then steps="{}"; fi
# value <step id> <output> <fallback>
value() {
  jq -r --arg id "$1" --arg key "$2" --arg fallback "$3" \
    '(.[$id].outputs[$key] // "") | if . == "" then $fallback else . end' <<<"$steps"
}

status="${JOB_STATUS:-unknown}"
if [ "$(value recheck go "")" = "false" ]; then
  status="skipped, production already runs a newer commit"
fi

cat >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}" <<EOF
### Production deploy: ${status}

| Item | Value |
|---|---|
| Commit | \`${SHA:-unresolved}\` (${TRIGGER:-unknown}) |
| API stack | $(value sam stack "not reached") (function $(value sam function "not reported")) |
| Web bucket | $(value tf web_bucket_name "not reached") |
| Distribution | $(value tf distribution_id "not reached") ($(value tf distribution_domain "n/a")), invalidation $(value cdn invalidation "not reached") |
| Site | ${SITE_URL:-} (Terraform site_url: $(value tf site_url "n/a")) |
| API version | $(value smoke version "not verified") |
EOF
