// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { API_CACHE_NAME, forgetCachedApi } from "../../lib/sw/apiCache";
import { loadWorker } from "./harness";

// The page removes cached API replies it cannot read. If its cache name drifted from the
// worker's, the removal would silently hit an empty cache and a bad copy would live on.

describe("forgetCachedApi", () => {
  it("names the same cache the worker stores the places in", () => {
    expect(loadWorker().constants.API_CACHE).toBe(API_CACHE_NAME);
  });

  it("deletes each path from the worker's API cache", async () => {
    const remove = vi.fn(async () => true);
    const open = vi.fn(async () => ({ delete: remove }) as unknown as Cache);
    await forgetCachedApi(["/api/places", "/api/meta"], { open });
    expect(open).toHaveBeenCalledWith(API_CACHE_NAME);
    expect(remove.mock.calls).toEqual([["/api/places"], ["/api/meta"]]);
  });

  it("never throws when storage is missing or broken", async () => {
    await expect(forgetCachedApi(["/api/places"], null)).resolves.toBeUndefined();
    const broken = {
      open: async () => {
        throw new Error("storage unavailable");
      },
    };
    await expect(forgetCachedApi(["/api/places"], broken)).resolves.toBeUndefined();
  });
});
