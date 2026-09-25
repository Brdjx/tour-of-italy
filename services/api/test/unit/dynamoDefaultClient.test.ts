import { describe, expect, it, vi } from "vitest";

// The DynamoDB store builds its real client on first use, once, with two attempts. The SDK is
// replaced here, so no AWS call is made.

const created = vi.hoisted(() => ({ configs: [] as unknown[], sends: 0 }));

vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  class DynamoDBClient {
    constructor(config: unknown) {
      created.configs.push(config);
    }
    async send() {
      created.sends++;
      return {};
    }
  }
  return { ...actual, DynamoDBClient };
});

const { createDynamoStore } = await import("../../src/trips/dynamoStore");

describe("the DynamoDB store's own client", () => {
  it("is created on first use, once, and shared by every store", async () => {
    const first = createDynamoStore("italy-planner-trips");
    const second = createDynamoStore("italy-planner-trips");
    expect(created.configs).toHaveLength(0);

    await first.putNew("trip#a", "x", 2_000_000_000, new AbortController().signal);
    await second.get("trip#a", new AbortController().signal);

    expect(created.configs).toEqual([{ maxAttempts: 2 }]);
    expect(created.sends).toBe(2);
  });
});
