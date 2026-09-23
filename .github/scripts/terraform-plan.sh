#!/usr/bin/env bash
# Plan infra/terraform/platform with the read-only plan role and save the result for publishing.
#
# Usage (from the repo root): bash .github/scripts/terraform-plan.sh
# Writes the plan text to $RUNNER_TEMP/plan.txt and exitcode=<0|1|2> to GITHUB_OUTPUT
# (terraform plan -detailed-exitcode: 0 no changes, 1 error, 2 changes).
#
# Decision: the plan role is read-only, so -lock=false (the S3 lock file is a write). The script
# records the exit code instead of failing, so the result is still published on errors; the
# workflow fails the job afterwards when the code is 1.
set -euo pipefail

: "${RUNNER_TEMP:?}" "${GITHUB_OUTPUT:?}"
cd infra/terraform/platform
terraform init -input=false

set +e
terraform plan -lock=false -input=false -no-color -detailed-exitcode -out=tfplan \
  >"$RUNNER_TEMP/plan.log" 2>&1
code=$?
set -e

cat "$RUNNER_TEMP/plan.log"
if [ "$code" -eq 1 ]; then
  cp "$RUNNER_TEMP/plan.log" "$RUNNER_TEMP/plan.txt"
else
  terraform show -no-color tfplan >"$RUNNER_TEMP/plan.txt"
fi
echo "exitcode=${code}" >>"$GITHUB_OUTPUT"
