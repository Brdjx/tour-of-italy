#!/usr/bin/env bash
# Run a Playwright suite through a root package.json script, once that script exists.
#
# Usage: run-e2e.sh <script>     e.g. run-e2e.sh test:e2e   or   run-e2e.sh test:e2e:smoke
#
# Decision: the E2E jobs are wired up before the suites exist. Until the root script is added
# this prints a notice and passes, and the job starts running the suite the day it lands, with
# no workflow change. Contract: @playwright/test is resolvable from the repo root.
set -euo pipefail

script="${1:?usage: run-e2e.sh <script>}"
if ! jq -e --arg name "$script" '.scripts[$name] // empty' package.json >/dev/null; then
  echo "::notice::No root script '${script}' yet, so there is nothing to run."
  exit 0
fi

pnpm install --frozen-lockfile
# Decision: Chromium and WebKit cover the device projects in the brief (Pixel, desktop, iPhone,
# iPad). --with-deps installs the system libraries the browsers need on the runner.
pnpm exec playwright install --with-deps chromium webkit
pnpm run "$script"
