/**
 * Health Check Route
 */

import type { Env } from "@/types/env";
import { Hono } from "hono";

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
  // Readiness check - verify D1 connection
  try {
    await c.env.DB.prepare("SELECT 1").first();

    return c.json({
      status: "ready",
      timestamp: new Date().toISOString(),
      checks: {
        database: "ok",
      },
    });
  } catch {
    return c.json(
      {
        status: "not_ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: "error",
        },
      },
      503
    );
  }
});

export default health;
