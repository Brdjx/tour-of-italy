import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { TripStore } from "./store";

// The one place that talks to DynamoDB (the table is TripsTable in infra/sam/template.yaml, named
// by TRIPS_TABLE). Everything else takes a TripStore, so tests pass a fake sender and never need
// AWS. The function's role may only GetItem and PutItem on that table.

/** The part of DynamoDBClient this module uses. */
export interface DynamoSender {
  send(
    command: PutItemCommand | GetItemCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<{ Item?: Record<string, { S?: string; N?: string } | undefined> | undefined }>;
}

// Decision: the client is created on first use, not at import, so tests and local development
// without a table never need AWS credentials or a region.
let sharedClient: DynamoDBClient | undefined;

function defaultClient(): DynamoSender {
  // Decision: two attempts in total, like the SSM client. The caller's time limit bounds both.
  sharedClient ??= new DynamoDBClient({ maxAttempts: 2 });
  return sharedClient as unknown as DynamoSender;
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export interface DynamoStoreOptions {
  client?: DynamoSender; // the real client by default
  now?: () => number;
}

export function createDynamoStore(table: string, options: DynamoStoreOptions = {}): TripStore {
  const now = options.now ?? Date.now;
  const client = () => options.client ?? defaultClient();
  return {
    kind: "dynamodb",
    async putNew(key, body, expiresAt, signal) {
      // A record is written once and never replaced while it lasts, so a repeated id or cache
      // key fails instead.
      // Decision: an expired record may be written over. get already treats it as gone, and
      // DynamoDB deletes it up to two days late; without this a cache key asked for again in
      // those days could never be cached again until the old item was deleted.
      const command = new PutItemCommand({
        TableName: table,
        Item: { pk: { S: key }, body: { S: body }, expiresAt: { N: String(expiresAt) } },
        ConditionExpression: "attribute_not_exists(pk) OR #expiresAt <= :now",
        ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: { ":now": { N: String(Math.floor(now() / 1000)) } },
      });
      try {
        await client().send(command, { abortSignal: signal });
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    async get(key, signal) {
      // Decision: a strongly consistent read. A trip is often saved seconds after its plan was
      // stored, and an eventually consistent read could miss that plan and drop its why lines.
      const command = new GetItemCommand({
        TableName: table,
        Key: { pk: { S: key } },
        ConsistentRead: true,
        ProjectionExpression: "#body, #expiresAt",
        ExpressionAttributeNames: { "#body": "body", "#expiresAt": "expiresAt" },
      });
      const output = await client().send(command, { abortSignal: signal });
      const body = output.Item?.body?.S;
      const expiresAt = Number(output.Item?.expiresAt?.N);
      if (body === undefined || !Number.isFinite(expiresAt)) return null;
      // DynamoDB deletes expired items within a day or two, not at once, so expiry is checked here.
      if (expiresAt * 1000 <= now()) return null;
      return body;
    },
  };
}
