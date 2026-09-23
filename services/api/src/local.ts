import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApp } from "./app";
import { loadConfig } from "./config";

// Local development server. Production traffic never reaches this file.

const WEB_DEV_ORIGIN = "http://localhost:3000";

// Decision: one optional .env at the repo root, read with Node's built-in parser instead of a
// dotenv dependency. Variables already set in the shell win over the file.
function loadRootEnvFile(): void {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

loadRootEnvFile();
const config = loadConfig();
const server = new Hono();

// Decision: CORS exists only here. In production CloudFront serves the web app and the API from
// one origin, so the Lambda never needs CORS headers.
server.use("/api/*", cors({ origin: WEB_DEV_ORIGIN }));
server.route("/", createApp({ config }));

const httpServer = serve({ fetch: server.fetch, port: config.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}/api/health`);
});

function shutdown(): void {
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
