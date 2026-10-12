import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { dryRunRetiredMiddleware } from "./dry-run-retired";

function buildGuardApp(handler: () => Response) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", dryRunRetiredMiddleware());
  app.all("*", () => handler());
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), 400);
    }
    throw err;
  });
  return app;
}

describe("dryRunRetiredMiddleware", () => {
  it.each(["true", "false", "", "maybe"])("refuses Dry-Run: %j with 400", async (value) => {
    const handler = vi.fn(() => new Response("ok"));
    const res = await buildGuardApp(handler).request(
      "/preview",
      { method: "POST", headers: { "Dry-Run": value } },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: "Dry-Run is retired" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes requests without the header", async () => {
    const handler = vi.fn(() => new Response("ok"));
    const res = await buildGuardApp(handler).request("/preview", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("Dry-Run on the public API", () => {
  // The refusal runs before authentication, so an unauthenticated request that
  // would otherwise be 401 proves the route was never reached.
  const app = createApp({
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
    observability: {
      captureException: () => {},
      withScope: () => {},
      withMonitor: async (_slug, fn) => fn(),
    },
  });

  it.each(["/v1/payments/transfers", "/v1/earn/vault-deposits"])(
    "refuses Dry-Run: true on POST %s with 400",
    async (path) => {
      const res = await app.request(
        path,
        {
          method: "POST",
          headers: { "Dry-Run": "true", "Content-Type": "application/json" },
          body: "{}",
        },
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { message: "Dry-Run is retired" } });
    }
  );
});
