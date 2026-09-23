#!/usr/bin/env bash
# Apply infra/terraform/platform, then report the outputs the rest of the deploy needs.
#
# Usage (from the repo root, with AWS credentials): bash .github/scripts/apply-platform.sh
# Writes web_bucket_name, distribution_id, distribution_domain and site_url to GITHUB_OUTPUT when
# that is set, and prints them either way.
set -euo pipefail

cd infra/terraform/platform
terraform init -input=false
terraform apply -auto-approve -input=false

outputs="$(terraform output -json)"
read_output() { jq -r --arg key "$1" '.[$key].value // empty' <<<"$outputs"; }

# Decision: only the bucket and distribution are required (the upload and invalidation need
# them). distribution_domain and site_url only feed the summary, so a missing one never fails a
# deploy after Terraform has already applied.
for key in web_bucket_name distribution_id; do
  if [ -z "$(read_output "$key")" ]; then
    echo "::error::Terraform output ${key} is missing"
    exit 1
  fi
done

result=""
for key in web_bucket_name distribution_id distribution_domain site_url; do
  result+="${key}=$(read_output "$key")"$'\n'
done
printf '%s' "$result"
if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s' "$result" >>"$GITHUB_OUTPUT"; fi
