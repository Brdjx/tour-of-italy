import { randomBytes } from "node:crypto";
import { RECORD_ID_LENGTH } from "@italy/planner";

// Ids for the records the API keeps (AI plans and saved trips): RECORD_ID_LENGTH characters of
// base62 from the operating system's random source. 62^10 is about 8e17 ids, so a saved trip's
// link cannot be guessed, and a collision is caught by the store's conditional write anyway.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Decision: bytes of 248 or more are skipped (248 is 4 x 62), so every character is equally
// likely. Taking byte % 62 for all bytes would make the first eight characters more common.
const UNBIASED_BELOW = 248;

export type RandomSource = (size: number) => Uint8Array;

/** A new record id. `random` is crypto.randomBytes by default; tests pass their own. */
export function newRecordId(random: RandomSource = randomBytes): string {
  let id = "";
  while (id.length < RECORD_ID_LENGTH) {
    for (const byte of random(RECORD_ID_LENGTH * 2)) {
      if (byte >= UNBIASED_BELOW) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === RECORD_ID_LENGTH) break;
    }
  }
  return id;
}
