/**
 * Health Check Route
 */

import { EGRESS_READINESS_SERVES_TRAFFIC, resolveSdpReleaseChannel } from "@sdp/types";
import { Hono } from "hono";
import { getDb } from "@/db/client";
import { pingRedis } from "@/runtime/kv-redis";
import type { Env } from "@/types/env";

export const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  const timestamp = new Date().toISOString();

  // Basic health check
  const health = {
    status: "ok",
    timestamp,
    version: c.env.API_VERSION,
    environment: c.env.ENVIRONMENT,
    // Lets the dashboard confirm it runs the same release channel as this API.
    releaseChannel: resolveSdpReleaseChannel(c.env.SDP_RELEASE_CHANNEL),
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
    // Undefined where nothing gates on egress, so the JSON omits it.
    egress: c.get("egressReadiness")?.(),
  };
  const body = {
    status:
      checks.database === "ok" &&
      checks.redis === "ok" &&
      (checks.egress === undefined || EGRESS_READINESS_SERVES_TRAFFIC[checks.egress])
        ? ("ready" as const)
        : ("not_ready" as const),
    timestamp: new Date().toISOString(),
    revision: c.env.K_REVISION ?? "local",
    // The prod deploy orders breaking migrations against the commit prod serves.
    commit: c.env.SDP_BUILD_SHA?.trim() || "local",
    checks,
  };

  return body.status === "ready" ? c.json(body) : c.json(body, 503);
});
