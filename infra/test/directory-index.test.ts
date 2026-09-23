import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Unit tests for the CloudFront Function in infra/terraform/platform/functions/directory-index.js.
// The file is a plain script (CloudFront calls `handler` by name), so it is evaluated here.

type Request = { uri: string; querystring: Record<string, { value: string }> };
type Handler = (event: { request: Request }) => Request;

const source = readFileSync(
  fileURLToPath(new URL("../terraform/platform/functions/directory-index.js", import.meta.url)),
  "utf8",
);
const handler = new Function(`${source}\nreturn handler;`)() as Handler;

function rewrite(uri: string): string {
  return handler({ request: { uri, querystring: {} } }).uri;
}

describe("directory index CloudFront Function", () => {
  it("serves the home page from index.html", () => {
    expect(rewrite("/")).toBe("/index.html");
  });

  it("serves /route/ from route/index.html so deep links never hit S3's 403", () => {
    expect(rewrite("/trip/")).toBe("/trip/index.html");
    expect(rewrite("/a/b/")).toBe("/a/b/index.html");
  });

  it("serves /route without the trailing slash from the same index.html", () => {
    expect(rewrite("/trip")).toBe("/trip/index.html");
    expect(rewrite("/404")).toBe("/404/index.html");
  });

  it("leaves hashed assets, the service worker and the manifest untouched", () => {
    for (const uri of [
      "/_next/static/chunks/0h08u3lxbuw4x.js",
      "/sw.js",
      "/manifest.webmanifest",
      "/icon-192.png",
      "/404.html",
    ]) {
      expect(rewrite(uri)).toBe(uri);
    }
  });

  it("only looks for a file extension in the last path segment", () => {
    expect(rewrite("/v1.2/notes")).toBe("/v1.2/notes/index.html");
  });

  it("keeps the query string, so shared plan links survive the rewrite", () => {
    const request = handler({ request: { uri: "/trip", querystring: { p: { value: "abc" } } } });
    expect(request.querystring).toEqual({ p: { value: "abc" } });
  });
});
