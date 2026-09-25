import type { CachedApiKey } from "@sdp/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { requireSandboxProject } from "./sandbox-project";

/**
 * Build a minimal app that injects the auth context vars a real chain would
 * have resolved, then runs the sandbox fence and reports what got through.
 */
function buildApp(setup: (c: Context<{ Bindings: Env }>) => void) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.use("*", requireSandboxProject());
  app.get("/probe", (c) => c.json({ reached: true }));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400 | 401 | 403);
    }
    throw err;
  });

  return app;
}

const productionKey = {
  environment: "production",
} as CachedApiKey;

const sandboxKey = {
  environment: "sandbox",
} as CachedApiKey;

describe("requireSandboxProject", () => {
  it("admits a sandbox project", async () => {
    const response = await buildApp((c) =>
      c.set("projectEnvironment", sandboxKey.environment)
    ).request("/probe", {}, env);
    expect(response.status).toBe(200);
  });

  it("rejects a production project", async () => {
    const response = await buildApp((c) =>
      c.set("projectEnvironment", productionKey.environment)
    ).request("/probe", {}, env);
    expect(response.status).toBe(403);
  });

  it("fails closed when no project environment resolved", async () => {
    const response = await buildApp(() => {}).request("/probe", {}, env);
    expect(response.status).toBe(403);
  });
});
