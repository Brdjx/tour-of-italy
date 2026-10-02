import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/appEnv";
import { sendError, zodDetails } from "../lib/httpErrors";

export interface PingRouteDeps {
  now: () => number;
}

const PingQuery = z.object({
  name: z.string().max(40).optional(),
});

export function registerPingRoute(app: Hono<AppEnv>, deps: PingRouteDeps): void {
  app.get("/ping", (c) => {
    const requestId = c.get("requestId");
    const ms = deps.now();
    const dateNow = new Date(ms).toISOString();

    const parsed = PingQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return sendError(c, 400, "bad_request", "Invalid query", zodDetails(parsed.error));
    }

    const name = parsed.data.name;
    if (name) {
      return c.json({ ok: true, at: dateNow, hello: name, requestId });
    }

    return c.json({ ok: true, at: dateNow, requestId });
  });
}
