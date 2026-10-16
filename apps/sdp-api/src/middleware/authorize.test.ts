import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, forbidden } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import {
  authorize,
  authorizeNone,
  declaredAuthorization,
  getAuthorized,
  hasAuthorized,
} from "./authorize";
import { validateBody, validateParams } from "./validate";

function testApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      // SAFETY: AppError status codes are the API's own error statuses.
      return c.json(err.toResponse(), err.statusCode as 400);
    }
    return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
  });
  return app;
}

function post(app: Hono<{ Bindings: Env }>, path: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("authorize()", () => {
  it("hands the check the validated request and the handler what it loaded", async () => {
    const check = vi.fn(async (_c: unknown, input: { params: unknown; body: unknown }) => ({
      wallet: `loaded ${JSON.stringify(input)}`,
    }));
    const app = testApp();
    app.post(
      "/v1/wallets/:walletId/act",
      validateParams(z.object({ walletId: z.string().transform((id) => id.toUpperCase()) })),
      validateBody(z.object({ amount: z.string().default("0") })),
      authorize(check),
      (c) => c.json(getAuthorized<{ wallet: string }>(c))
    );

    const res = await post(app, "/v1/wallets/w1/act", {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      wallet: `loaded ${JSON.stringify({ params: { walletId: "W1" }, body: { amount: "0" } })}`,
    });
  });

  it("refuses before the handler runs", async () => {
    const handler = vi.fn(() => new Response("ran"));
    const app = testApp();
    app.post(
      "/v1/things",
      authorize(() => {
        throw forbidden("not yours");
      }),
      handler
    );

    expect((await post(app, "/v1/things", {})).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("marks a route with no named resource, and fails loudly on a route with no step", async () => {
    const app = testApp();
    app.post("/v1/none", authorizeNone("names nothing beyond its scope"), (c) =>
      c.json({ authorized: hasAuthorized(c) })
    );
    app.post("/v1/missing", (c) => c.json(getAuthorized(c)));

    expect(await (await post(app, "/v1/none", {})).json()).toEqual({ authorized: true });
    expect((await post(app, "/v1/missing", {})).status).toBe(500);
  });

  it("declares what each step is, for the route inventory", () => {
    expect(declaredAuthorization(authorize(() => undefined))).toEqual({ kind: "checked" });
    expect(declaredAuthorization(authorizeNone("why"))).toEqual({ kind: "none", reason: "why" });
    expect(declaredAuthorization(() => undefined)).toBeUndefined();
  });
});
