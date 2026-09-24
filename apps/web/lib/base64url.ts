// UTF-8 safe base64url (RFC 4648 section 5, no padding) for share links. Browser and Node both
// provide btoa, atob, TextEncoder and TextDecoder, so no dependency is needed.

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Base64url text for a string, with no padding. */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The string a base64url value encodes, or null when it is not valid base64url or not valid
 * UTF-8. Never throws.
 */
export function fromBase64Url(value: string): string | null {
  if (value === "" || !BASE64URL.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
