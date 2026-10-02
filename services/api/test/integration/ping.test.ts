import { describe, expect, it } from "vitest";
import { FIXED_NOW, makeApp } from "../helpers/app";

describe("GET /api/ping", () => {
  it("returns ok and the time from the app's clock", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/ping");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; at: string };
    expect(body.ok).toBe(true);
    expect(body.at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it("returns a name", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/ping?name=Bradley");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hello: string };
    expect(body.ok).toBe(true);
    expect(body.hello).toBe("Bradley");
  });

  it("has a name that is too long", async () => {
    const { app } = makeApp();
    const res = await app.request(`/api/ping?name=${"a".repeat(41)}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("uses the wrong method", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/ping", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });
});
