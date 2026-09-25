// Bundles the Lambda entry into a single ESM file: services/api/dist/lambda.mjs (+ .map).
// SAM deploys the dist folder as is (CodeUri ../../services/api/dist, Handler lambda.handler).
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const outdir = fileURLToPath(new URL("./dist/", import.meta.url));

// Decision: wipe dist first so a stale file can never ship next to the new bundle.
rmSync(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: packageDir,
  entryPoints: ["src/lambda.ts"],
  outfile: "dist/lambda.mjs",
  bundle: true,
  platform: "node",
  // Decision: match the Lambda runtime (nodejs24.x) so esbuild does not down-level syntax.
  target: "node24",
  format: "esm",
  // Decision: source maps on and minify off, so stack traces in CloudWatch point at real lines
  // (the function runs with NODE_OPTIONS=--enable-source-maps).
  sourcemap: true,
  sourcesContent: false,
  minify: false,
  // Decision: bundle every dependency, including the AWS SDK, so the deployed code is exactly
  // what was tested instead of whatever SDK version the runtime happens to ship. That holds for
  // the DynamoDB client too (about 350 KB of the bundle), although nodejs24.x ships SDK v3.
  // Some bundled CommonJS packages call require(); ESM output has no require, so recreate it.
  banner: {
    js: [
      'import { createRequire as __italyCreateRequire } from "node:module";',
      "const require = __italyCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
