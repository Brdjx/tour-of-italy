import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// .github/scripts/smoke-test.sh against a stub curl, so every branch runs without a network. The
// stub answers like the live stack: the site host (with /api/health), the API host (/health, no
// /api prefix), the direct execute-api URL and the direct S3 URL. Each case breaks one thing.

const script = fileURLToPath(new URL("../../.github/scripts/smoke-test.sh", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SITE = "https://site.test";
const API = "https://api.test";

// Answers by URL. FAKE_* variables let a case break one answer.
const FAKE_CURL = `#!/usr/bin/env bash
url="" write="" dump=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -w) write="$2"; shift 2 ;;
    -D) dump="$2"; shift 2 ;;
    -o | --max-time | --retry | -X | -H | --data) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
code=404 location="" body='{"error":{"code":"not_found"}}' headers="all"
health() { body="{\\"ok\\":true,\\"commit\\":\\"$1\\",\\"version\\":\\"1.2.3\\"}"; code=200; }
case "$url" in
  "${SITE}/api/health") health "$FAKE_SITE_COMMIT" ;;
  "${API}/health") health "$FAKE_API_COMMIT"; headers="$FAKE_API_HEADERS" ;;
  "${API}/api/health") code=404 ;;
  "${SITE}/") code=200 body="<html></html>" ;;
  "http://site.test/") code=301 location="${SITE}/" ;;
  "http://api.test/health") code="$FAKE_API_HTTP_CODE" location="$FAKE_API_HTTP_LOCATION" ;;
  https://abc123def4.execute-api.*) code=403 ;;
  https://italy-planner-web-*.s3.*) code=403 ;;
esac
if [ "$dump" = "-" ]; then
  printf 'HTTP/2 %s\\r\\ncontent-type: application/json\\r\\n' "$code"
  if [ "$headers" = "all" ]; then
    printf 'Strict-Transport-Security: max-age=63072000; includeSubDomains\\r\\n'
    printf "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'\\r\\n"
    printf 'X-Content-Type-Options: nosniff\\r\\nReferrer-Policy: strict-origin-when-cross-origin\\r\\n'
    printf 'X-Frame-Options: DENY\\r\\n'
  fi
  printf '\\r\\n'
fi
if [ -n "$write" ]; then
  printf '%s' "$write" | sed -e "s|%{http_code}|$code|" -e "s|%{redirect_url}|$location|"
elif [ "$dump" != "-" ]; then
  [ "$code" -ge 400 ] && exit 22
  printf '%s' "$body"
fi
`;

type Run = { status: number | null; summary: string; output: string; stdout: string };

const workdirs: string[] = [];
afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runSmoke(overrides: Record<string, string | undefined> = {}): Run {
  const workdir = mkdtempSync(join(tmpdir(), "smoke-test-"));
  workdirs.push(workdir);
  const bin = join(workdir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  // A failing health check retries 12 times, 15 s apart; the stub sleep keeps the test fast.
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "curl"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);
  const summary = join(workdir, "summary.md");
  const output = join(workdir, "output.txt");
  writeFileSync(summary, "");
  writeFileSync(output, "");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SITE_URL: SITE,
    API_URL: API,
    SHA,
    WEB_BUCKET: "italy-planner-web-388773186626",
    HTTP_API_URL: "https://abc123def4.execute-api.us-east-1.amazonaws.com/",
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
    FAKE_SITE_COMMIT: SHA,
    FAKE_API_COMMIT: SHA,
    FAKE_API_HEADERS: "all",
    FAKE_API_HTTP_CODE: "301",
    FAKE_API_HTTP_LOCATION: `${API}/health`,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("bash", [script], { env, encoding: "utf8" });
  return {
    status: result.status,
    summary: readFileSync(summary, "utf8"),
    output: readFileSync(output, "utf8"),
    stdout: `${result.stdout}${result.stderr}`,
  };
}

const row = (run: Run, check: string) =>
  run.summary.split("\n").find((line) => line.startsWith(`| ${check} |`)) ?? "";

describe("smoke-test.sh", () => {
  it("passes when both hosts serve this commit securely and the origins refuse direct calls", () => {
    const run = runSmoke();
    expect(run.status, run.stdout).toBe(0);
    for (const check of [
      "site /api/health reports this commit",
      "API host /health reports this commit",
      "site redirects HTTP to HTTPS",
      "API host redirects HTTP to HTTPS",
      "security headers on the site",
      "security headers on the API host",
      "direct execute-api URL refused",
      "direct S3 object URL refused",
    ]) {
      expect(row(run, check), check).toContain("| pass |");
    }
    expect(run.output).toBe("version=1.2.3\n");
  });

  it("fails when the API host still serves another commit", () => {
    const run = runSmoke({ FAKE_API_COMMIT: "f".repeat(40) });
    expect(run.status).toBe(1);
    expect(row(run, "API host /health reports this commit")).toContain("| fail |");
    expect(row(run, "site /api/health reports this commit")).toContain("| pass |");
  });

  it("fails when plain HTTP to the API host is not redirected to the same HTTPS URL", () => {
    const refused = runSmoke({ FAKE_API_HTTP_CODE: "403", FAKE_API_HTTP_LOCATION: "" });
    expect(refused.status).toBe(1);
    expect(row(refused, "API host redirects HTTP to HTTPS")).toContain("| fail |");

    const elsewhere = runSmoke({ FAKE_API_HTTP_LOCATION: "https://evil.test/health" });
    expect(elsewhere.status).toBe(1);
    expect(row(elsewhere, "API host redirects HTTP to HTTPS")).toContain("| fail |");
  });

  it("fails when the API host loses its security headers", () => {
    const run = runSmoke({ FAKE_API_HEADERS: "none" });
    expect(run.status).toBe(1);
    expect(row(run, "security headers on the API host")).toContain("missing hsts");
    expect(row(run, "security headers on the site")).toContain("| pass |");
  });

  it("refuses to run without the API host, instead of silently skipping its checks", () => {
    const run = runSmoke({ API_URL: undefined });
    expect(run.status).not.toBe(0);
    expect(run.summary).toBe("");
  });
});
