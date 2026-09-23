#!/usr/bin/env bash
# Decide whether an automatic deploy of <sha> may replace what production runs now.
#
# Usage: SITE_URL=https://... deploy-guard.sh <sha>     (run inside a full clone: fetch-depth 0)
# Prints "true" or "false" on stdout. Explanations go to stderr as workflow annotations.
#
# Decision: an automatic deploy only moves production forward. Re-running an older commit's CI
# fires a fresh workflow_run event, and without this check it would silently roll production
# back. The live commit comes from /api/health. When it is unknown (site down, first deploy,
# a build that is not on main), deploying is the safe choice, because the new commit is on main
# and passed CI. Deliberate rollbacks use workflow_dispatch, which never calls this script.
set -euo pipefail

sha="${1:?usage: deploy-guard.sh <sha>}"
: "${SITE_URL:?SITE_URL is required}"

live="$(curl -sS --max-time 10 --fail "${SITE_URL}/api/health" 2>/dev/null |
  jq -r '.commit // empty' 2>/dev/null || true)"

# The response is untrusted input: only a full lowercase SHA is used, and nothing else is echoed.
if ! [[ "$live" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::notice::Live commit unknown, deploying ${sha}" >&2
  echo true
  exit 0
fi

if ! git cat-file -e "${live}^{commit}" 2>/dev/null; then
  echo "::notice::Live commit ${live} is not in this repository's history, deploying ${sha}" >&2
  echo true
  exit 0
fi

if git merge-base --is-ancestor "$live" "$sha"; then
  echo "Production runs ${live}, an ancestor of ${sha} (or the same commit): deploying" >&2
  echo true
else
  echo "::notice::Production already runs ${live}, which is not an ancestor of ${sha}." \
    "Skipping so an older commit never replaces a newer one. To roll back on purpose, run" \
    "deploy.yml with workflow_dispatch and ref=${sha}." >&2
  echo false
fi
