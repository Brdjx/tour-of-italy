import type { BrowserContext, Route } from "@playwright/test";

// The map's tile archive in tests. The real one (about 140 MB, apps/web/public/tiles) is never
// committed and is uploaded to the site bucket by hand, so CI has none and the page's read of it
// would end in a 404, which the browser logs as a console error. The tests answer it with an
// empty archive instead: a valid PMTiles header over no tiles. The map then draws its stops and
// route on blank paper, with no error, the same on every machine.

/** Where the archive is read from (TILES_PATH in apps/web/lib/mapStyle.ts). */
export const TILES_ROUTE = "**/tiles/**";

const HEADER_BYTES = 127;
const ROOT_DIRECTORY = Uint8Array.of(0); // no entries
const METADATA = new TextEncoder().encode("{}");

/**
 * A PMTiles v3 archive with no tiles: the 127-byte header, a root directory with no entries and
 * empty metadata, uncompressed. The bounds are Italy's, so the protocol reads them as valid.
 */
export function emptyTileArchive(): Buffer {
  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + ROOT_DIRECTORY.length;
  const dataOffset = metadataOffset + METADATA.length;
  const bytes = Buffer.alloc(dataOffset);
  bytes.write("PMTiles", 0, "ascii");
  bytes.writeUInt8(3, 7); // spec version
  const u64 = (at: number, value: number) => bytes.writeBigUInt64LE(BigInt(value), at);
  u64(8, rootOffset);
  u64(16, ROOT_DIRECTORY.length);
  u64(24, metadataOffset);
  u64(32, METADATA.length);
  u64(40, dataOffset); // leaf directories: none
  u64(48, 0);
  u64(56, dataOffset); // tile data: none
  u64(64, 0);
  // 72 to 95: addressed tiles, tile entries and tile contents, all zero.
  bytes.writeUInt8(1, 96); // clustered
  bytes.writeUInt8(1, 97); // internal compression: none
  bytes.writeUInt8(1, 98); // tile compression: none
  bytes.writeUInt8(1, 99); // tile type: vector (MVT)
  bytes.writeUInt8(0, 100); // min zoom
  bytes.writeUInt8(15, 101); // max zoom
  const degrees = (at: number, value: number) => bytes.writeInt32LE(Math.round(value * 1e7), at);
  degrees(102, 6.6); // min longitude
  degrees(106, 36.6); // min latitude
  degrees(110, 18.6); // max longitude
  degrees(114, 47.1); // max latitude
  bytes.writeUInt8(6, 118); // center zoom
  degrees(119, 12.5);
  degrees(123, 42.5);
  Buffer.from(ROOT_DIRECTORY).copy(bytes, rootOffset);
  Buffer.from(METADATA).copy(bytes, metadataOffset);
  return bytes;
}

const ARCHIVE = emptyTileArchive();

/** Answers a read of the archive with the bytes it asks for, as S3 answers a Range request. */
async function answer(route: Route): Promise<void> {
  const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
  const first = Number(match?.[1] ?? 0);
  const last = Math.min(match?.[2] ? Number(match[2]) : ARCHIVE.length - 1, ARCHIVE.length - 1);
  if (!match || first > last) {
    await route.fulfill({ status: 200, contentType: "application/octet-stream", body: ARCHIVE });
    return;
  }
  await route.fulfill({
    status: 206,
    contentType: "application/octet-stream",
    headers: { "content-range": `bytes ${first}-${last}/${ARCHIVE.length}` },
    body: ARCHIVE.subarray(first, last + 1),
  });
}

/** Serves the empty archive to every page in the context. */
export async function useEmptyTiles(context: BrowserContext): Promise<void> {
  await context.route(TILES_ROUTE, answer);
}
