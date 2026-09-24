import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createRuntimeDeps } from "./runtime";

// Local development server. Production traffic never reaches this file. CORS for the Next dev
// server is set inside createApp (outside production only).

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
server.route("/", createApp(createRuntimeDeps(config)));

// Decision: listen on the loopback interface only, unless HOST says otherwise (HOST=0.0.0.0 to
// test from a phone on the same network). Outside production there is no origin check and the
// key in .env is real, so anyone on the same Wi-Fi could otherwise spend it.
const hostname = process.env.HOST?.trim() || "127.0.0.1";

const httpServer = serve({ fetch: server.fetch, port: config.port, hostname }, (info) => {
  console.log(
    `API listening on http://${hostname}:${info.port}/api/health (model client: ${config.llmMode})`,
  );
});

function shutdown(): void {
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
