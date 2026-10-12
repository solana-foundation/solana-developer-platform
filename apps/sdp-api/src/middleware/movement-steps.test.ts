import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AppError, forbidden } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { authorize } from "./authorize";
import { admit, replayFromRecord } from "./movement-steps";

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

function post(app: Hono<{ Bindings: Env }>, headers: Record<string, string> = {}) {
  return app.request("/v1/move", { method: "POST", headers }, env);
}

describe("movement steps", () => {
  it("answers from the domain row before admission, so admission never refuses a request that ran", async () => {
    const find = vi.fn(async (_c, input: { authorized: { walletId: string } }, key: string) =>
      key === "ran" ? new Response(`row for ${input.authorized.walletId}`) : null
    );
    const refuse = vi.fn(async () => {
      throw forbidden("organization may not start movements");
    });
    const handler = vi.fn(() => new Response("moved"));
    const app = testApp();
    app.post(
      "/v1/move",
      authorize(() => ({ walletId: "w1" })),
      replayFromRecord(find),
      admit(refuse),
      handler
    );

    const replayed = await post(app, { "Idempotency-Key": "ran" });
    expect(await replayed.text()).toBe("row for w1");
    expect(refuse).not.toHaveBeenCalled();

    expect((await post(app, { "Idempotency-Key": "new" })).status).toBe(403);
    expect((await post(app)).status).toBe(403);
    expect(find).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes admitted work to the handler with what authorize loaded", async () => {
    const check = vi.fn(async (_c, input: { authorized: string }) => {
      expect(input.authorized).toBe("loaded");
    });
    const app = testApp();
    app.post(
      "/v1/move",
      authorize(() => "loaded"),
      admit(check),
      () => new Response("moved")
    );

    expect(await (await post(app)).text()).toBe("moved");
    expect(check).toHaveBeenCalledOnce();
  });
});
