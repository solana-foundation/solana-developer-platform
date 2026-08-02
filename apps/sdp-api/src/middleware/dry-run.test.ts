import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { dryRunMiddleware, isDryRunRequest } from "./dry-run";

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", dryRunMiddleware());
  app.all("*", (c) => c.json({ dryRun: isDryRunRequest(c) }));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), 400);
    }
    throw error;
  });
  return app;
}

describe("dryRunMiddleware", () => {
  it("passes requests without the Dry-Run header", async () => {
    const response = await buildApp().request("/preview", {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dryRun: false });
  });

  it.each([
    ["true", true],
    ["false", false],
    [" true ", true],
    [" false ", false],
  ])("accepts %j", async (value, expected) => {
    const response = await buildApp().request("/preview", { headers: { "Dry-Run": value } }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dryRun: expected });
  });

  it.each(["TRUE", "1", "yes", ""])("rejects %j", async (value) => {
    const response = await buildApp().request("/preview", { headers: { "Dry-Run": value } }, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Dry-Run must be exactly true or false",
      },
    });
  });
});
