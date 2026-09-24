import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { ParameterFetcher } from "./secrets";

// The one place that talks to SSM Parameter Store. Everything else takes a ParameterFetcher, so
// tests pass a fake and never need AWS.

/** The part of SSMClient this module uses. */
export interface SsmSender {
  send(
    command: GetParameterCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<{
    Parameter?: { Value?: string | undefined } | undefined;
  }>;
}

// Decision: the client is created on first use, not at import, so tests and local development
// that never read a parameter never need AWS credentials or a region.
let sharedClient: SSMClient | undefined;

function defaultClient(): SsmSender {
  // Decision: two attempts in total. The caller's timeout bounds the whole read anyway.
  sharedClient ??= new SSMClient({ maxAttempts: 2 });
  return sharedClient;
}

/** Reads SecureString parameters with decryption. Throws when the parameter has no value. */
export function createSsmFetcher(client?: SsmSender): ParameterFetcher {
  return async (name, signal) => {
    const sender = client ?? defaultClient();
    const command = new GetParameterCommand({ Name: name, WithDecryption: true });
    const output = await sender.send(command, { abortSignal: signal });
    const value = output.Parameter?.Value;
    if (value === undefined || value === "") {
      throw new Error(`Parameter ${name} has no value`);
    }
    return value;
  };
}
