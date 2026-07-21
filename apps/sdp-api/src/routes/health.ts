/**
 * Health Check Route
 */

import { Hono } from "hono";
import { getDb } from "@/db";
import { pingRedis } from "@/runtime/kv-redis";
import type { Env } from "@/types/env";

const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  const timestamp = new Date().toISOString();

  // Basic health check
  const health = {
    status: "ok",
    timestamp,
    version: c.env.API_VERSION,
    environment: c.env.ENVIRONMENT,
  };

  return c.json(health);
});

health.get("/ready", async (c) => {
  const [database, redis] = await Promise.allSettled([
    getDb(c.env).prepare("SELECT 1").first(),
    pingRedis(c.env),
  ]);
  const checks = {
    database: database.status === "fulfilled" ? ("ok" as const) : ("error" as const),
    redis: redis.status === "fulfilled" ? ("ok" as const) : ("error" as const),
  };
  const body = {
    status:
      checks.database === "ok" && checks.redis === "ok"
        ? ("ready" as const)
        : ("not_ready" as const),
    timestamp: new Date().toISOString(),
    revision: c.env.K_REVISION ?? "local",
    checks,
  };

  return body.status === "ready" ? c.json(body) : c.json(body, 503);
});

export default health;
