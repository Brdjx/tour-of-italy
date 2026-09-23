#!/usr/bin/env bash
# Download a release archive, check it against a pinned SHA-256, and extract it.
#
# Usage: fetch-verified.sh <url> <sha256> <dest-dir>
#
# Decision: every tool CI or the deploy runs outside node_modules comes through here, so each one
# is pinned by digest. A replaced release asset or a poisoned mirror fails the check instead of
# running. Nothing is read from or written to the shared Actions cache.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: fetch-verified.sh <url> <sha256> <dest-dir>" >&2
  exit 2
fi
url="$1"
expected="$2"
dest="$3"

if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "expected a 64-character lowercase SHA-256, got '${expected}'" >&2
  exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
archive="${workdir}/$(basename "$url")"

curl -sSfL --retry 3 --proto '=https' --tlsv1.2 -o "$archive" "$url"
# A plain string compare works with both GNU and macOS sha256sum, so the script also runs locally.
actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
if [ "$actual" != "$expected" ]; then
  echo "SHA-256 mismatch for $(basename "$url"): expected ${expected}, got ${actual}" >&2
  exit 1
fi
echo "SHA-256 verified: $(basename "$url")"

mkdir -p "$dest"
case "$archive" in
  *.tar.gz | *.tgz) tar -xzf "$archive" -C "$dest" ;;
  *.zip) unzip -q -o "$archive" -d "$dest" ;;
  *)
    echo "unsupported archive type: ${archive}" >&2
    exit 2
    ;;
esac
