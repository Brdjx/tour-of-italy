import { describe, expect, it } from "vitest";
import { readJsonBody } from "../../src/lib/body";
import { clientIp, rateLimitKey, stripPort } from "../../src/lib/clientIp";
import { resolveRequestId } from "../../src/lib/requestId";

function jsonRequest(
  body: string | Uint8Array | null,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://local/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("resolveRequestId", () => {
  it("keeps a plain caller id so a trace can be followed across systems", () => {
    expect(resolveRequestId("abc-123_X.y:z", () => "generated")).toBe("abc-123_X.y:z");
  });

  it("replaces ids that could inject headers or log lines", () => {
    for (const bad of ["a\r\nset-cookie: x", "a b", "<script>", "x".repeat(129), ""]) {
      expect(resolveRequestId(bad, () => "generated")).toBe("generated");
    }
    expect(resolveRequestId(undefined, () => "generated")).toBe("generated");
  });

  it("generates a UUID by default", () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("readJsonBody", () => {
  it("parses a small JSON body", async () => {
    const result = await readJsonBody(jsonRequest('{"a":1}'), 100);

    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("answers 413 from Content-Length before reading a huge body", async () => {
    const request = jsonRequest("{}", { "content-length": "999999" });

    const result = await readJsonBody(request, 100);

    expect(result).toMatchObject({ ok: false, status: 413, code: "payload_too_large" });
  });

  it("answers 413 when the body is larger than declared, so a lying header cannot bypass the cap", async () => {
    const big = JSON.stringify({ notes: "x".repeat(500) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const request = new Request("http://local/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const result = await readJsonBody(request, 100);

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("answers 400 for malformed JSON, an empty body, and invalid UTF-8", async () => {
    expect(await readJsonBody(jsonRequest("{nope"), 100)).toMatchObject({
      status: 400,
      code: "invalid_json",
    });
    expect(await readJsonBody(jsonRequest(""), 100)).toMatchObject({
      status: 400,
      code: "invalid_json",
    });
    const badUtf8 = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(await readJsonBody(jsonRequest(badUtf8), 100)).toMatchObject({ status: 400 });
  });

  it("answers 415 unless the body is declared as JSON, which keeps cross-site form posts out", async () => {
    const form = new Request("http://local/api/plan", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });

    expect(await readJsonBody(form, 100)).toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
  });

  it("accepts a charset parameter on the JSON content type", async () => {
    const request = jsonRequest("[1]", { "content-type": "application/json; charset=utf-8" });

    expect(await readJsonBody(request, 100)).toEqual({ ok: true, value: [1] });
  });
});

describe("clientIp", () => {
  const headers = (values: Record<string, string>) => (name: string) => values[name];

  it("prefers CloudFront-Viewer-Address, which the client cannot set", () => {
    const ip = clientIp(
      headers({ "cloudfront-viewer-address": "198.51.100.10:46532", "x-forwarded-for": "1.1.1.1" }),
      "10.0.0.1",
    );

    expect(ip).toBe("198.51.100.10");
  });

  it("strips the port from IPv6 viewer addresses", () => {
    expect(stripPort("2001:db8::1:443")).toBe("2001:db8::1");
    expect(stripPort("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(stripPort("203.0.113.5")).toBe("203.0.113.5");
  });

  it("keeps a bare IPv6 address whole instead of cutting its last group as a port", () => {
    expect(stripPort("2001:db8::1")).toBe("2001:db8::1");
    expect(stripPort("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2:3:4:5:6");
    expect(stripPort("2001:db8:1:2:3:4:5:6:443")).toBe("2001:db8:1:2:3:4:5:6");
  });

  it("puts every address of one IPv6 /64 in one rate-limit bucket, so rotating addresses cannot bypass it", () => {
    expect(rateLimitKey("2001:db8:1:2::aaaa")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:ffff:1:2:3")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(rateLimitKey("2001:db8:1:2::1"));
  });

  it("keys IPv4 on the full address, and an IPv4-mapped IPv6 address as that IPv4 address", () => {
    expect(rateLimitKey("198.51.100.10")).toBe("198.51.100.10");
    expect(rateLimitKey("::ffff:198.51.100.10")).toBe("198.51.100.10");
    expect(rateLimitKey("unknown")).toBe("unknown");
  });

  it("falls back to the first X-Forwarded-For entry, then the platform source IP", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), "10.0.0.2")).toBe(
      "203.0.113.7",
    );
    expect(clientIp(headers({}), "10.0.0.2")).toBe("10.0.0.2");
    expect(clientIp(headers({}), undefined)).toBe("unknown");
  });

  it("ignores header values that are not IP addresses, so junk cannot become a limiter key", () => {
    const ip = clientIp(
      headers({ "cloudfront-viewer-address": "<script>", "x-forwarded-for": "not-an-ip" }),
      "10.0.0.3",
    );

    expect(ip).toBe("10.0.0.3");
  });
});
