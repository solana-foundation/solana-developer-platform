import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { idempotencyKeyMiddleware } from "./idempotency-key";

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", idempotencyKeyMiddleware());
  app.all("*", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), 400);
    }
    throw err;
  });
  return app;
}

describe("idempotencyKeyMiddleware", () => {
  it("echoes a valid key back on the response", async () => {
    const app = buildApp();
    const res = await app.request(
      "/foo",
      { headers: { "Idempotency-Key": "invoice_1234/payout+retry=" } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Key")).toBe("invoice_1234/payout+retry=");
  });

  it("passes through requests without a key and sets no echo header", async () => {
    const app = buildApp();
    const res = await app.request("/foo", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Key")).toBeNull();
  });

  it("rejects a key longer than 255 characters", async () => {
    const app = buildApp();
    const res = await app.request("/foo", { headers: { "Idempotency-Key": "k".repeat(256) } }, env);
    expect(res.status).toBe(400);
  });

  it("rejects an empty key", async () => {
    const app = buildApp();
    const res = await app.request("/foo", { headers: { "Idempotency-Key": "" } }, env);
    expect(res.status).toBe(400);
  });
});
