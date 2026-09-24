import { loadConfig } from "./config";
import { createLambdaHandler } from "./runtime";

// AWS Lambda entry point, bundled by build.mjs into dist/lambda.mjs (handler: lambda.handler).
// Config is parsed once per cold start; an invalid environment fails the init phase loudly.

export const handler = createLambdaHandler(loadConfig());
