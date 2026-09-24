// Serves the built static export (apps/web/out) the way CloudFront serves it in production, and
// proxies /api/* to the local API, so the browser sees one origin exactly like the live site.
// No dependencies: Node built-ins only.
//
// Usage: node e2e/serve.mjs
//   E2E_WEB_PORT   port to listen on (default 14390), always on 127.0.0.1
//   E2E_API_PORT   port of the local API (default 18790)
//   E2E_WEB_ROOT   folder to serve (default apps/web/out)
//
// What it mirrors from infra/terraform/platform and .github/scripts/publish-web.sh:
// - the directory-index function: "/x/" and "/x" serve "/x/index.html"; paths with a dot pass
// - a missing file answers 404 with /404.html (the distribution's custom error response)
// - Cache-Control: hashed /_next/static files are immutable, everything else (sw.js and the
//   manifest included) is no-cache
// - byte ranges, as S3 behind CloudFront answers them: the map reads its tile archive
//   (/tiles/*.pmtiles) with Range requests
// - the security headers policy, with the CSP read from headers.tf
// - /api/* forwarded unchanged, with the viewer address in CloudFront-Viewer-Address

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 14390);
const API_PORT = Number(process.env.E2E_API_PORT ?? 18790);
const ROOT = resolve(process.env.E2E_WEB_ROOT ?? join(REPO, "apps", "web", "out"));
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", // MapLibre's worker, a module
  ".pmtiles": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

// Headers a proxy must not forward (RFC 9110 section 7.6.1), plus the test-only client header.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "x-e2e-client",
]);

/** The production Content-Security-Policy, read from the Terraform that deploys it. */
export async function productionCsp(file = join(REPO, "infra/terraform/platform/headers.tf")) {
  const tf = await readFile(file, "utf8");
  const block = /csp_directives\s*=\s*\[([\s\S]*?)\n\s*\]/.exec(tf)?.[1];
  if (!block) throw new Error(`Could not read the CSP from ${file}`);
  const directives = [...block.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => String(match[1]));
  if (!directives.some((d) => d.startsWith("script-src"))) {
    throw new Error(`The CSP in ${file} has no script-src; the parser is out of date`);
  }
  // A Terraform reference (${local.x}) would reach the browser as literal text.
  if (directives.some((d) => d.includes("${"))) {
    throw new Error(
      `The CSP in ${file} uses a Terraform reference; the parser does not resolve them`,
    );
  }
  // Decision: drop upgrade-insecure-requests. This server is plain http on 127.0.0.1, and the
  // directive would rewrite every subresource to https. Production is https only, where it is
  // a no-op for same-origin files.
  return directives.filter((d) => d !== "upgrade-insecure-requests").join("; ");
}

function securityHeaders(csp) {
  return {
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-xss-protection": "0",
    "content-security-policy": csp,
    "permissions-policy": "camera=(), microphone=(), payment=(), usb=(), browsing-topics=()",
    "cross-origin-opener-policy": "same-origin",
  };
}

/** The file path for a URL path, as the directory-index CloudFront Function rewrites it. */
export function objectKey(pathname) {
  if (pathname.endsWith("/")) return `${pathname}index.html`;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".") ? pathname : `${pathname}/index.html`;
}

/**
 * A stable fake viewer address per test. Each Playwright test sends its own x-e2e-client value,
 * so the API's per-client rate limit counts each test separately, as it would count separate
 * travelers, instead of one bucket for the whole parallel suite.
 */
export function viewerAddress(clientId, socketAddress) {
  if (!clientId) return socketAddress ?? "127.0.0.1";
  const digest = createHash("sha256").update(clientId).digest();
  return `10.${digest[0]}.${digest[1]}.${digest[2]}`;
}

/**
 * Test hook for the new-version flow: a context that sets the cookie e2e-sw-build=<token> gets a
 * sw.js with a different build id, which is exactly what a new deploy looks like to the browser.
 */
// Decision: a per-context cookie instead of a global switch, so a test that "deploys" a new
// version never changes what tests running in parallel see.
export function swVariant(source, cookieHeader) {
  const token = /(?:^|;\s*)e2e-sw-build=([a-z0-9]{1,16})(?:;|$)/.exec(cookieHeader ?? "")?.[1];
  if (!token) return source;
  return source.replace(/^const BUILD_ID = "([^"\n]*)";$/m, `const BUILD_ID = "$1-${token}";`);
}

async function readIfFile(path) {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

async function sizeIfFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * The bytes a Range header asks for, as [first, last] (inclusive); null to send the whole file;
 * "unsatisfiable" for a range past the end. One range only: a server may ignore a Range header
 * (RFC 9110 section 14.2), so anything else gets the whole file, as S3 does with multiple ranges.
 */
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(match[2]);
    return suffix === 0 || size === 0 ? "unsatisfiable" : [Math.max(0, size - suffix), size - 1];
  }
  const first = Number(match[1]);
  const last = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (first >= size) return "unsatisfiable";
  return first > last ? null : [first, last];
}

async function serveStatic(req, res, url, headers) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(403, { ...headers, "content-type": "text/plain" }).end("Method not allowed");
    return;
  }
  let key;
  try {
    key = decodeURIComponent(objectKey(url.pathname));
  } catch {
    res.writeHead(400, { ...headers, "content-type": "text/plain" }).end("Bad request");
    return;
  }
  const path = resolve(ROOT, `.${key}`);
  const inside = path === ROOT || path.startsWith(ROOT + sep);
  const size = inside ? await sizeIfFile(path) : null;
  if (size === null) {
    const page = join(ROOT, "404.html");
    const body = (await readIfFile(page)) ?? Buffer.from("Not found");
    res.writeHead(404, {
      ...headers,
      "content-type": TYPES[".html"],
      "content-length": body.byteLength,
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  const immutable = key.startsWith("/_next/static/");
  const fileHeaders = {
    ...headers,
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    "cache-control": immutable ? "public,max-age=31536000,immutable" : "no-cache",
    "accept-ranges": "bytes",
  };
  if (key === "/sw.js") {
    const body = Buffer.from(swVariant(String(await readFile(path)), req.headers.cookie));
    res.writeHead(200, { ...fileHeaders, "content-length": body.byteLength });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  const range = byteRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...fileHeaders, "content-range": `bytes */${size}` }).end();
    return;
  }
  // Decision: files are streamed, not read whole. The tile archive is over 100 MB and the map
  // asks for a few kilobytes of it at a time.
  const [first, last] = range ?? [0, size - 1];
  const length = size === 0 ? 0 : last - first + 1;
  res.writeHead(range ? 206 : 200, {
    ...fileHeaders,
    "content-length": length,
    ...(range ? { "content-range": `bytes ${first}-${last}/${size}` } : {}),
  });
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  createReadStream(path, { start: first, end: last })
    .on("error", () => res.destroy())
    .pipe(res);
}

function proxyApi(req, res, headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) forwarded[name] = value;
  }
  const clientId = req.headers["x-e2e-client"];
  const viewer = viewerAddress(
    typeof clientId === "string" ? clientId : "",
    req.socket.remoteAddress,
  );
  forwarded["cloudfront-viewer-address"] = `${viewer}:${req.socket.remotePort ?? 443}`;
  forwarded.host = `${HOST}:${API_PORT}`;
  const upstream = httpRequest(
    { host: HOST, port: API_PORT, path: req.url, method: req.method, headers: forwarded },
    (answer) => {
      const out = { ...answer.headers, ...headers };
      // CloudFront serves the site and the API from one origin, so no CORS headers reach the page.
      for (const name of Object.keys(out)) {
        if (name.startsWith("access-control-") || HOP_BY_HOP.has(name)) delete out[name];
      }
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) return void res.destroy();
    // Like CloudFront when the origin cannot be reached: a 502 with an HTML body.
    res.writeHead(502, { ...headers, "content-type": "text/html" }).end("<h1>502 Bad Gateway</h1>");
  });
  req.pipe(upstream);
}

export async function startServer() {
  const headers = securityHeaders(await productionCsp());
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${WEB_PORT}`);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      proxyApi(req, res, headers);
      return;
    }
    serveStatic(req, res, url, headers).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Server error");
    });
  });
  await new Promise((done) => server.listen(WEB_PORT, HOST, done));
  return server;
}

if (import.meta.main) {
  const index = await readIfFile(join(ROOT, "index.html"));
  if (!index) {
    console.error(`${ROOT}/index.html is missing. Build the web app first.`);
    process.exit(1);
  }
  const server = await startServer();
  console.log(`Serving ${ROOT} on http://${HOST}:${WEB_PORT} (/api -> ${HOST}:${API_PORT})`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
