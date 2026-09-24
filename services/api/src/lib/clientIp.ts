import { isIP } from "node:net";

// The traveler's IP address, for per-client rate limiting. Behind CloudFront the Lambda sees
// CloudFront's address as the source, so the viewer address has to come from a header.

type HeaderLookup = (name: string) => string | undefined;

// Plain IPv4 or IPv6 text. Anything else in a header is ignored rather than trusted as a key.
const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * "198.51.100.10:46532" -> "198.51.100.10"; "2001:db8::1:46532" -> "2001:db8::1";
 * "[2001:db8::1]:443" -> "2001:db8::1". CloudFront always appends the viewer port.
 */
// Decision: the last ":digits" is a port only when what is left is still an IP address, so a
// bare IPv6 address without a port ("2001:db8::1") is kept whole instead of being cut to
// "2001:db8:".
export function stripPort(value: string): string {
  const text = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed?.[1]) return bracketed[1];
  const colon = text.lastIndexOf(":");
  if (colon <= 0 || !/^\d{1,5}$/.test(text.slice(colon + 1))) return text;
  const rest = text.slice(0, colon);
  return isIP(rest) !== 0 ? rest : text;
}

function validIp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return IP_TEXT.test(trimmed) ? trimmed : undefined;
}

/**
 * Client IP in order of trust: CloudFront-Viewer-Address (set by CloudFront from the TCP
 * connection), then the first X-Forwarded-For entry, then the platform's source IP.
 */
// Decision: the first X-Forwarded-For entry is only a fallback. A client can put anything there,
// so production relies on CloudFront-Viewer-Address (forwarded by the AllViewerExceptHostHeader
// origin request policy) and on the WAF's per-IP rule; this limiter is a second line.
export function clientIp(header: HeaderLookup, sourceIp: string | undefined): string {
  const viewer = header("cloudfront-viewer-address");
  const fromViewer = viewer === undefined ? undefined : validIp(stripPort(viewer));
  if (fromViewer) return fromViewer;
  const forwarded = header("x-forwarded-for")?.split(",")[0];
  const fromForwarded = validIp(forwarded);
  if (fromForwarded) return fromForwarded;
  return validIp(sourceIp) ?? "unknown";
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  // An embedded IPv4 tail ("::ffff:192.0.2.1") becomes two hex groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  return groups.length === 8 ? groups.map((group) => Number.parseInt(group, 16)) : null;
}

/**
 * The rate-limit key for an address: IPv4 as is, IPv6 cut to its /64 network ("2001:db8:1:2::/64").
 * An IPv4-mapped IPv6 address counts as its IPv4 address.
 */
// Decision: every IPv6 subscriber holds at least a /64, so keying on the full address would give
// one traveler 2^64 separate buckets. The /64 is the smallest block one client is known to own.
export function rateLimitKey(ip: string): string {
  const groups = ipv6Groups(ip);
  if (groups === null) return ip;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}
