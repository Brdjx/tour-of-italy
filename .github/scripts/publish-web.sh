#!/usr/bin/env bash
# Upload the static site to S3 and invalidate CloudFront, waiting until the edge serves it.
#
# Usage (from the repo root, with AWS credentials):
#   WEB_BUCKET=<bucket> DISTRIBUTION_ID=<id> bash .github/scripts/publish-web.sh
# Needs apps/web/out already built. Writes invalidation=<id> to GITHUB_OUTPUT when that is set.
set -euo pipefail

: "${WEB_BUCKET:?}" "${DISTRIBUTION_ID:?}"
out="apps/web/out"
[ -f "${out}/index.html" ] || { echo "::error::${out}/index.html is missing, build the web app first"; exit 1; }

# Hashed assets first, so new HTML never points at a file that is not there yet.
aws s3 sync "${out}/_next/static" "s3://${WEB_BUCKET}/_next/static" \
  --cache-control "public,max-age=31536000,immutable" --no-progress --only-show-errors

# Decision: everything else revalidates on each request (sw.js and the manifest included) and
# --delete removes pages that no longer exist. Old hashed assets are excluded from the delete so
# open tabs keep working. The map's tile archive (tiles/*.pmtiles) is excluded too: it is not in
# git, so CI builds never have it, and it is uploaded to the bucket once by hand; without the
# exclude, every deploy would delete it.
aws s3 sync "$out" "s3://${WEB_BUCKET}" --exclude "_next/static/*" --exclude "tiles/*" --delete \
  --cache-control "no-cache" --no-progress --only-show-errors

id="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" --query Invalidation.Id --output text)"
echo "invalidation=${id}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "invalidation=${id}" >>"$GITHUB_OUTPUT"; fi
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION_ID" --id "$id"
