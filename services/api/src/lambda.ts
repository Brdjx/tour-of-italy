import { handle } from "hono/aws-lambda";
import { createApp } from "./app";
import { loadConfig } from "./config";

// AWS Lambda entry point, bundled by build.mjs into dist/lambda.mjs (handler: lambda.handler).
// Config is parsed once per cold start; an invalid environment fails the init phase loudly.

const app = createApp({ config: loadConfig() });

export const handler = handle(app);
