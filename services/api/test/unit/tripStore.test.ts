import { readFileSync } from "node:fs";
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { createDynamoStore, type DynamoSender } from "../../src/trips/dynamoStore";
import { newRecordId } from "../../src/trips/ids";
import {
  createMemoryStore,
  expiresAtFrom,
  KEEP_SECONDS,
  MAX_ID_ATTEMPTS,
  MEMORY_STORE_ENTRIES,
  StoreCollisionError,
  StoreTimeoutError,
  saveNew,
  type TripStore,
  withinTime,
} from "../../src/trips/store";

// The trips store: record ids, the in-memory store, the time limit on every call, the retry on
// a taken id, and the DynamoDB store against a fake client (no AWS).

const signal = () => new AbortController().signal;
const NOW = Date.UTC(2026, 8, 23, 12);
const LATER = Math.floor(NOW / 1000) + 60;

describe("newRecordId", () => {
  it("makes 10 letters and digits from the random source", () => {
    const ids = Array.from({ length: 200 }, () => newRecordId());
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips bytes that would make some characters more likely", () => {
    // 248 to 255 are skipped; 61 is the last character, 62 wraps to the first.
    let call = 0;
    const random = (size: number) =>
      call++ === 0 ? new Uint8Array(size).fill(250) : new Uint8Array(size).fill(61);
    expect(newRecordId(random)).toBe("zzzzzzzzzz");
    expect(newRecordId(() => new Uint8Array(20).fill(62))).toBe("0000000000");
  });
});

describe("the in-memory store", () => {
  it("writes a key once, reads it back, and hides it once expired", async () => {
    let now = NOW;
    const store = createMemoryStore(() => now);

    expect(await store.putNew("trip#a", "one", LATER, signal())).toBe(true);
    expect(await store.putNew("trip#a", "two", LATER, signal())).toBe(false);
    expect(await store.get("trip#a", signal())).toBe("one");
    expect(await store.get("trip#b", signal())).toBeNull();
    now = LATER * 1000;
    expect(await store.get("trip#a", signal())).toBeNull();
  });

  it("writes over a record once it has expired", async () => {
    let now = NOW;
    const store = createMemoryStore(() => now);
    await store.putNew("cache#k", "old", LATER, signal());

    now = LATER * 1000;
    expect(await store.putNew("cache#k", "new", LATER + 60, signal())).toBe(true);
    expect(await store.get("cache#k", signal())).toBe("new");
  });

  it("keeps at most MEMORY_STORE_ENTRIES records, dropping the oldest", async () => {
    const store = createMemoryStore(() => NOW);
    for (let i = 0; i <= MEMORY_STORE_ENTRIES; i++) {
      await store.putNew(`trip#${i}`, String(i), LATER, signal());
    }
    expect(await store.get("trip#0", signal())).toBeNull();
    expect(await store.get(`trip#${MEMORY_STORE_ENTRIES}`, signal())).toBe(
      String(MEMORY_STORE_ENTRIES),
    );
  });

  it("uses the real clock by default", async () => {
    const store = createMemoryStore();
    await store.putNew("plan#a", "x", expiresAtFrom(Date.now(), 60), signal());
    expect(await store.get("plan#a", signal())).toBe("x");
  });
});

describe("expiry and time limits", () => {
  it("keeps plans 90 days, trips a year and cached plans a week, in epoch seconds", () => {
    expect(expiresAtFrom(NOW, KEEP_SECONDS.plan)).toBe(NOW / 1000 + 90 * 86_400);
    expect(expiresAtFrom(NOW + 999, KEEP_SECONDS.trip)).toBe(NOW / 1000 + 365 * 86_400);
    expect(expiresAtFrom(NOW, KEEP_SECONDS.cache)).toBe(NOW / 1000 + 7 * 86_400);
  });

  it("keeps a plan record as long as the page keeps its last plan, so any plan it shows saves with its AI text", () => {
    const lastPlan = readFileSync(new URL("../../../../apps/web/lib/lastPlan.ts", import.meta.url));
    const days = /LAST_PLAN_MAX_AGE_DAYS = (\d+);/.exec(lastPlan.toString())?.[1];
    expect(KEEP_SECONDS.plan).toBe(Number(days) * 86_400);
  });

  it("never serves a cached plan after the plan record its planId points at is gone", () => {
    expect(KEEP_SECONDS.cache).toBeLessThanOrEqual(KEEP_SECONDS.plan);
  });

  it("gives up on a call at its limit and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const call = withinTime((given) => {
      seen = given;
      return new Promise<string>(() => {});
    }, 20);

    await expect(call).rejects.toBeInstanceOf(StoreTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("returns the call's value, and turns a synchronous throw into a rejection", async () => {
    expect(await withinTime(async () => "ok", 1000)).toBe("ok");
    await expect(
      withinTime(() => {
        throw new Error("sync");
      }, 1000),
    ).rejects.toThrow("sync");
  });
});

describe("saveNew", () => {
  const zeros = (size: number) => new Uint8Array(size);

  it("writes under a new id and returns it", async () => {
    const store = createMemoryStore(() => NOW);

    const id = await saveNew(store, (given) => `body of ${given}`, {
      prefix: "trip",
      expiresAt: LATER,
      timeoutMs: 1000,
      random: zeros,
    });

    expect(id).toBe("0000000000");
    expect(await store.get("trip#0000000000", signal())).toBe("body of 0000000000");
  });

  it("gives up with StoreCollisionError when every id tried is taken", async () => {
    const store = createMemoryStore(() => NOW);
    await store.putNew("plan#0000000000", "taken", LATER, signal());

    const save = saveNew(store, () => "mine", {
      prefix: "plan",
      expiresAt: LATER,
      timeoutMs: 1000,
      random: zeros,
    });

    await expect(save).rejects.toBeInstanceOf(StoreCollisionError);
    expect(await store.get("plan#0000000000", signal())).toBe("taken");
    expect(MAX_ID_ATTEMPTS).toBe(3);
  });

  it("passes on a store error", async () => {
    const broken: TripStore = {
      kind: "memory",
      putNew: async () => {
        throw new Error("down");
      },
      get: async () => null,
    };
    const save = saveNew(broken, () => "x", { prefix: "trip", expiresAt: LATER, timeoutMs: 100 });
    await expect(save).rejects.toThrow("down");
  });
});

/** A fake DynamoDB client that records commands and answers with `answer`. */
function fakeDynamo(answer: (command: PutItemCommand | GetItemCommand) => unknown) {
  const sent: { command: PutItemCommand | GetItemCommand; signal: AbortSignal }[] = [];
  const client: DynamoSender = {
    send: async (command, options) => {
      sent.push({ command, signal: options.abortSignal });
      const result = answer(command);
      if (result instanceof Error) throw result;
      return result as never;
    },
  };
  return { client, sent };
}

function conditionFailed(): Error {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

describe("the DynamoDB store", () => {
  it("writes the record as JSON text with its expiry, only when the key is free", async () => {
    const { client, sent } = fakeDynamo(() => ({}));
    const store = createDynamoStore("italy-planner-trips", { client, now: () => NOW });
    const given = signal();

    expect(store.kind).toBe("dynamodb");
    expect(await store.putNew("trip#abc", '{"v":1}', LATER, given)).toBe(true);
    const put = sent[0]?.command as PutItemCommand;
    expect(put).toBeInstanceOf(PutItemCommand);
    expect(put.input).toEqual({
      TableName: "italy-planner-trips",
      Item: { pk: { S: "trip#abc" }, body: { S: '{"v":1}' }, expiresAt: { N: String(LATER) } },
      // Free: no item, or one whose time is up (DynamoDB deletes those up to two days late).
      ConditionExpression: "attribute_not_exists(pk) OR #expiresAt <= :now",
      ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
      ExpressionAttributeValues: { ":now": { N: String(NOW / 1000) } },
    });
    expect(sent[0]?.signal).toBe(given);
  });

  it("reports a taken key as false and passes on any other error", async () => {
    const taken = createDynamoStore("t", { client: fakeDynamo(conditionFailed).client });
    const denied = createDynamoStore("t", {
      client: fakeDynamo(() => new Error("AccessDeniedException")).client,
    });

    expect(await taken.putNew("trip#abc", "x", LATER, signal())).toBe(false);
    await expect(denied.putNew("trip#abc", "x", LATER, signal())).rejects.toThrow("AccessDenied");
  });

  it("reads with a consistent read and returns the body until it expires", async () => {
    let expiresAt = LATER;
    const { client, sent } = fakeDynamo(() => ({
      Item: { body: { S: "stored" }, expiresAt: { N: String(expiresAt) } },
    }));
    const store = createDynamoStore("italy-planner-trips", { client, now: () => NOW });

    expect(await store.get("trip#abc", signal())).toBe("stored");
    const get = sent[0]?.command as GetItemCommand;
    expect(get).toBeInstanceOf(GetItemCommand);
    expect(get.input).toMatchObject({
      TableName: "italy-planner-trips",
      Key: { pk: { S: "trip#abc" } },
      ConsistentRead: true,
    });
    // DynamoDB removes expired items a day or two late; the store treats them as gone at once.
    expiresAt = Math.floor(NOW / 1000);
    expect(await store.get("trip#abc", signal())).toBeNull();
  });

  it("treats a missing item, or one without a body or expiry, as none", async () => {
    for (const answer of [
      {},
      { Item: { expiresAt: { N: "9" } } },
      { Item: { body: { S: "x" } } },
    ]) {
      const store = createDynamoStore("t", { client: fakeDynamo(() => answer).client });
      expect(await store.get("trip#abc", signal())).toBeNull();
    }
  });
});
