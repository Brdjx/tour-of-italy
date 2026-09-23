#!/usr/bin/env bash
# Deploy the API stack with SAM, then report its outputs.
#
# Usage (from the repo root, with AWS credentials): SHA=<commit> AWS_REGION=us-east-1 \
#   bash .github/scripts/deploy-api.sh
# Needs services/api/dist already built. Writes stack, function and http_api_url to GITHUB_OUTPUT
# when that is set, and prints them either way.
set -euo pipefail

: "${SHA:?SHA (the commit being deployed) is required}"
: "${AWS_REGION:?}"
# The reader sits next to this script, which may come from a different commit than infra/.
reader="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/read-samconfig.py"
cd infra/sam

# Decision: samconfig.toml owns the stack name, so CI and a local sam deploy always hit the same
# stack. It is passed explicitly so describe-stacks below cannot disagree with sam deploy.
stack="$(python3 "$reader" stack-name samconfig.toml)"

# sam deploy drops samconfig's parameter_overrides when --parameter-overrides is given, so they
# are carried over and GitSha goes last (the SAM CLI applies overrides in order, last wins).
text="$(python3 "$reader" overrides samconfig.toml)"
overrides=()
# A read loop instead of mapfile, so the script also runs under macOS bash 3.2.
while IFS= read -r line; do if [ -n "$line" ]; then overrides+=("$line"); fi; done <<<"$text"

sam deploy --stack-name "$stack" --region "$AWS_REGION" \
  --no-confirm-changeset --no-fail-on-empty-changeset --no-progressbar \
  --parameter-overrides ${overrides[@]+"${overrides[@]}"} "GitSha=${SHA}"

outputs="$(aws cloudformation describe-stacks --stack-name "$stack" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs" --output json)"
output() {
  jq -r --arg key "$1" '(. // [])[] | select(.OutputKey == $key) | .OutputValue' <<<"$outputs"
}

# ApiFunctionName only feeds the summary, so a missing one is not an error. HttpApiUrl is checked
# by the smoke test, which reports it missing without stopping the rest of the deploy.
result="stack=${stack}
function=$(output ApiFunctionName)
http_api_url=$(output HttpApiUrl)"
echo "$result"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$result" >>"$GITHUB_OUTPUT"; fi
