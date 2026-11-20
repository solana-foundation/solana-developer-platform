import { Hono } from "hono";

export function createApp(): Hono {
  const app = new Hono();

  // Liveness is constant and touches no dependency.
  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}
