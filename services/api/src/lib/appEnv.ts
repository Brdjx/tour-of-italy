import type { LogFields } from "./logger";

// The Hono environment type shared by every route and middleware.

/**
 * What the platform passes as c.env: the Lambda adapter gives the API Gateway event and request
 * context, the Node server gives the incoming socket. Tests usually pass nothing, so every field
 * is optional and read defensively.
 */
export interface AppBindings {
  requestContext?: { http?: { sourceIp?: string } };
  incoming?: { socket?: { remoteAddress?: string } };
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    requestId: string; // resolved request id, echoed in x-request-id
    arrivedAt: number; // clock reading when the request reached the app, for the plan deadline
    logFields: LogFields; // extra fields for this request's log line
  };
};

/** The platform's view of the caller's address, when it has one. */
export function platformSourceIp(env: AppBindings | undefined): string | undefined {
  return env?.requestContext?.http?.sourceIp ?? env?.incoming?.socket?.remoteAddress ?? undefined;
}
