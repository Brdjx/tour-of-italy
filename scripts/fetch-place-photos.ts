// Downloads the curated Wikimedia Commons photos and writes their credits for the web app.
// Run with `pnpm photos:fetch`. Add `--force` to download files that are already on disk.
//
// In:  data/place-photos.json, the curation: which Commons file shows each place, plus city
//      and topic fallbacks, with a short description (used in alt text) and a focal point.
// Out: apps/web/public/photos/<key>-500.jpg and <key>-960.jpg for every photo, and
//      apps/web/lib/placePhotos.data.json with the credit of each one (author, license, source).
//
// Requests go one at a time with a pause, as Wikimedia asks of scripts. The script stops with
// exit code 1 when a photo's license is not one the site may use (see ALLOWED_LICENSES).
// A photo whose Commons file changed in the curation is downloaded again, and files for keys
// that left the curation are removed, so the folder always matches the curation.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const CURATION_PATH = fileURLToPath(new URL("../data/place-photos.json", import.meta.url));
const PHOTOS_DIR = fileURLToPath(new URL("../apps/web/public/photos/", import.meta.url));
const DATA_PATH = fileURLToPath(new URL("../apps/web/lib/placePhotos.data.json", import.meta.url));

const API_URL = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "3DaysInItaly/1.0 (https://italy-planner.brdjx.com)";
// Decision: 500 and 960 px, not 480 and 960. Commons serves thumbnails in standard widths and
// answers a request for 480 px with its 500 px file, so a "480" file would really be 500 px
// wide and its srcset width would be wrong. 960 is a standard width too.
export const WIDTHS = [500, 960] as const;
const PAUSE_MS = 300;
const MAX_ATTEMPTS = 4;
const RETRY_PAUSE_MS = 5000;
// Decision: a longer credit is usually a whole sentence of attribution instructions or a list
// of links, too long to print under a photo. The uploader's user name is used instead.
const MAX_AUTHOR_LENGTH = 60;

// Licenses the site may show with a credit: CC0, public domain (including the PD marks), and
// Creative Commons BY or BY-SA of any version, with or without a country port ("CC BY-SA 3.0 de").
// Anything else (NC, ND, GFDL only, "all rights reserved") stops the script.
const ALLOWED_LICENSES = [
  /^CC0( 1\.0)?$/i,
  /^Public domain( mark( \d\.\d)?)?$/i,
  /^PDM( \d\.\d)?$/i,
  /^CC BY(-SA)? \d\.\d( [a-z]{2,3})?$/i,
];

export function isAllowedLicense(license: string): boolean {
  return ALLOWED_LICENSES.some((pattern) => pattern.test(license));
}

/** One photo in data/place-photos.json. */
interface CuratedPhoto {
  file: string; // the Commons file title, "File:Colosseo 2020.jpg"
  description: string; // what the photo shows, for alt text
  focal: string; // CSS object-position that keeps the subject in a square crop, "50% 40%"
  // Decision: an optional author, for the few files whose Commons credit does not work as a
  // printed name: a whole block of text, where the script would fall back to the user name but
  // the photographer asks for his full name ("Wolfgang Moroder", not "Moroder"), or a template
  // leftover ("I, Sailko"). Leave it out otherwise.
  author?: string;
}

interface Curation {
  places: Record<string, CuratedPhoto>; // keyed by place id
  fallbacks: Record<string, CuratedPhoto>; // keyed "city:<City>" or "type:<type>"
}

/** One row of apps/web/lib/placePhotos.data.json. */
export interface PhotoRecord {
  key: string;
  file: string;
  sourceUrl: string; // the file's page on Commons
  author: string;
  license: string;
  licenseUrl: string | null; // null for public domain files, which have none
  width: number; // of the 960 px file, as measured on disk
  height: number;
  description: string;
  focal: string;
}

/** The part of the Commons imageinfo answer this script reads. */
interface ImageInfo {
  thumburl: string;
  descriptionurl: string;
  user: string;
  extmetadata?: Record<string, { value?: unknown } | undefined>;
}

/** "city:Isola della Scala" becomes "city-isola-della-scala"; "place_001" stays as it is. */
export function fileStem(key: string): string {
  return key.toLowerCase().replace(":", "-").replaceAll(" ", "-");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Plain text from the HTML Commons returns for the author: tags removed (a line break becomes a
 * space), entities decoded, whitespace collapsed.
 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }
      if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The credited author: the Attribution field, else the Artist field, else the uploader, skipping
 * a field that is empty or too long. Full stops, commas and semicolons at either end are
 * dropped, since the credit adds its own punctuation ("Carlo Ferrari." and ". Ray in Manila").
 */
// Decision: Attribution comes first. The CC licenses ask for the credit "in any reasonable
// manner requested" by the author, and Attribution is where a Commons author makes that request
// (the Galleria Borghese photo's Artist is the user name Blackcat; its Attribution is
// "Sergio D'Afflitto").
export function authorOf(attributionHtml: string, artistHtml: string, uploader: string): string {
  for (const html of [attributionHtml, artistHtml]) {
    const text = plainText(html).replace(/^[\s.,;]+|[\s.,;]+$/g, "");
    if (text !== "" && text.length <= MAX_AUTHOR_LENGTH) return text;
  }
  return uploader;
}

/** Width and height from a JPEG's frame header, or null when the bytes are not a JPEG. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes.readUInt8(offset) !== 0xff) return null;
    const marker = bytes.readUInt8(offset + 1);
    // The start-of-frame markers C0 to CF hold the size; C4, C8 and CC are other tables.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

/** GET with the project's User-Agent. Retries a few times on 429 and 5xx, with a growing wait. */
async function get(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.ok) return response;
    const retry = response.status === 429 || response.status >= 500;
    if (!retry || attempt === MAX_ATTEMPTS) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    await pause(RETRY_PAUSE_MS * attempt);
  }
}

/** The Commons imageinfo for one file, with a thumbnail URL for the given width. */
async function imageInfo(file: string, width: number): Promise<ImageInfo> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|size|extmetadata|user",
    iiurlwidth: String(width),
    iiextmetadatafilter: "Artist|Attribution|LicenseShortName|LicenseUrl|Restrictions",
    titles: file,
  });
  const response = await get(`${API_URL}?${params}`);
  const body = (await response.json()) as {
    query?: { pages?: { missing?: boolean; imageinfo?: ImageInfo[] }[] };
  };
  const page = body.query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  if (!page || page.missing || !info) throw new Error(`Commons has no file named ${file}`);
  return info;
}

function metadata(info: ImageInfo, field: string): string {
  const value = info.extmetadata?.[field]?.value;
  return typeof value === "string" ? value : "";
}

/**
 * Downloads a thumbnail unless the file exists and `fresh` is false, then checks that what is
 * on disk is a JPEG of the expected width. Returns its real size.
 */
async function download(
  url: string,
  path: string,
  width: number,
  fresh: boolean,
): Promise<{ width: number; height: number; downloaded: boolean }> {
  const downloaded = fresh || !existsSync(path);
  if (downloaded) {
    const response = await get(url);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    await pause(PAUSE_MS);
  }
  const size = jpegSize(readFileSync(path));
  if (!size) throw new Error(`${path} is not a JPEG`);
  if (size.width !== width) throw new Error(`${path} is ${size.width} px wide, not ${width}`);
  return { ...size, downloaded };
}

/** Every curated photo as [key, photo], sorted by key. Throws on a malformed entry. */
function readCuration(): [string, CuratedPhoto][] {
  const curation = JSON.parse(readFileSync(CURATION_PATH, "utf8")) as Curation;
  const entries = [...Object.entries(curation.places), ...Object.entries(curation.fallbacks)];
  for (const [key, photo] of entries) {
    const isFallback = key.startsWith("city:") || key.startsWith("type:");
    if (key.includes(":") !== isFallback) throw new Error(`Unexpected key ${key}`);
    if (Object.hasOwn(curation.places, key) === isFallback) {
      throw new Error(`${key} is in the wrong section`);
    }
    if (!photo.file.startsWith("File:")) throw new Error(`${key}: file must start with "File:"`);
    if (photo.description.trim() === "") throw new Error(`${key}: description is empty`);
    if (photo.author?.trim() === "") throw new Error(`${key}: author is empty; leave it out`);
    if (!/^\d{1,3}% \d{1,3}%$/.test(photo.focal)) {
      throw new Error(`${key}: focal must look like "50% 40%", not ${photo.focal}`);
    }
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The Commons file each key had when the script last wrote placePhotos.data.json. A key whose
 * file changed since then gets its photos downloaded again, even without --force.
 */
function previousFiles(): Map<string, string> {
  if (!existsSync(DATA_PATH)) return new Map();
  const rows = JSON.parse(readFileSync(DATA_PATH, "utf8")) as PhotoRecord[];
  return new Map(rows.map((row) => [row.key, row.file]));
}

/** Deletes the files in the photos folder that no curated photo uses any more. */
function removeUnusedFiles(records: PhotoRecord[]): void {
  const used = new Set(
    records.flatMap((record) => WIDTHS.map((width) => `${fileStem(record.key)}-${width}.jpg`)),
  );
  for (const name of readdirSync(PHOTOS_DIR)) {
    if (used.has(name)) continue;
    unlinkSync(`${PHOTOS_DIR}${name}`);
    console.log(`Removed ${name}: no curated photo uses it.`);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const entries = readCuration();
  const previous = previousFiles();
  mkdirSync(PHOTOS_DIR, { recursive: true });
  const records: PhotoRecord[] = [];
  const refused: string[] = [];
  let downloads = 0;

  for (const [key, photo] of entries) {
    const infos: ImageInfo[] = [];
    for (const width of WIDTHS) {
      infos.push(await imageInfo(photo.file, width));
      await pause(PAUSE_MS);
    }
    const [small, large] = infos as [ImageInfo, ImageInfo];
    const license = metadata(large, "LicenseShortName");
    if (!isAllowedLicense(license)) {
      refused.push(`${key}: ${photo.file} is "${license}"`);
      continue;
    }
    // Restrictions are rules beyond copyright, such as "ita-mibac" (Italy's cultural heritage
    // code, which covers commercial reproductions of monuments) or "personality" (people shown).
    // They do not stop the script, but they are printed so the owner sees them.
    const restrictions = metadata(large, "Restrictions");
    if (restrictions !== "") console.warn(`${key}: Commons lists restrictions: ${restrictions}`);
    const stem = fileStem(key);
    const fresh = force || previous.get(key) !== photo.file;
    const smallFile = await download(
      small.thumburl,
      `${PHOTOS_DIR}${stem}-${WIDTHS[0]}.jpg`,
      WIDTHS[0],
      fresh,
    );
    const largeFile = await download(
      large.thumburl,
      `${PHOTOS_DIR}${stem}-${WIDTHS[1]}.jpg`,
      WIDTHS[1],
      fresh,
    );
    downloads += Number(smallFile.downloaded) + Number(largeFile.downloaded);
    const record: PhotoRecord = {
      key,
      file: photo.file,
      sourceUrl: large.descriptionurl,
      author:
        photo.author ??
        authorOf(metadata(large, "Attribution"), metadata(large, "Artist"), large.user),
      license,
      licenseUrl: metadata(large, "LicenseUrl") || null,
      width: largeFile.width,
      height: largeFile.height,
      description: photo.description,
      focal: photo.focal,
    };
    records.push(record);
    console.log(`${key}: ${record.license}, ${record.author}`);
  }

  if (refused.length > 0) {
    console.error(`Stopped: ${refused.length} photo(s) have a license the site cannot use.`);
    for (const line of refused) console.error(`  ${line}`);
    console.error("Pick another file in data/place-photos.json, or remove the entry.");
    process.exit(1);
  }
  removeUnusedFiles(records);
  writeFileSync(DATA_PATH, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`${records.length} photos, ${downloads} files downloaded. Wrote ${DATA_PATH}`);
}

if (import.meta.main) await main();
