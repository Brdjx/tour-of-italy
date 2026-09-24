#!/usr/bin/env bash
# Builds the self-hosted map tiles (apps/web/public/tiles/italy-<date>.pmtiles) from a Protomaps
# daily build, cut to the areas this trip uses. About 140 MB and a few minutes.
#
# Usage: scripts/map-tiles/build-tiles.sh <build date YYYYMMDD> [path to the pmtiles CLI]
#   A current build date is listed at https://build-metadata.protomaps.dev/builds.json; daily
#   builds are only kept for a while. The pmtiles CLI is a single binary from
#   https://github.com/protomaps/go-pmtiles/releases (check it against the release checksums).
#
# Three zoom bands, merged into one archive:
#   0 to 10    the whole trip area (a rectangle over the five bases and their day trips)
#   11 to 12   region-wide.geojson: the close areas plus bands out to every day trip
#   13 to 15   region.geojson: 5 km around each place, 12 km around each base
# After building, point TILES_PATH in apps/web/lib/mapStyle.ts at the new file and upload it once
# (docs/deploy.md, "Map tiles"). Deploys never delete tiles/ from the bucket.
set -euo pipefail

date="${1:?usage: build-tiles.sh <build date YYYYMMDD> [pmtiles CLI]}"
pmtiles="${2:-pmtiles}"
[[ "$date" =~ ^[0-9]{8}$ ]] || { echo "build date must be YYYYMMDD" >&2; exit 2; }

repo="$(cd "$(dirname "$0")/../.." && pwd)"
build="https://build.protomaps.com/${date}.pmtiles"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="${repo}/apps/web/public/tiles/italy-${date}.pmtiles"

(cd "$repo" && pnpm exec tsx scripts/map-tiles/regions.ts "$work")
"$pmtiles" extract "$build" "$work/context.pmtiles" --bbox=8.8,41.6,13.0,46.1 --maxzoom=10
"$pmtiles" extract "$build" "$work/mid.pmtiles" --region="$work/region-wide.geojson" --minzoom=11 --maxzoom=12
"$pmtiles" extract "$build" "$work/near.pmtiles" --region="$work/region.geojson" --minzoom=13 --maxzoom=15
mkdir -p "$(dirname "$out")"
rm -f "$out"
"$pmtiles" merge "$work/context.pmtiles" "$work/mid.pmtiles" "$work/near.pmtiles" "$out"
"$pmtiles" verify "$out"
echo "wrote $out ($(wc -c <"$out" | tr -d ' ') bytes)"
