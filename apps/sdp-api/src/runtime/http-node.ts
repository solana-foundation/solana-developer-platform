import { Hono } from "hono";
import { compress } from "hono/compress";

import type { Env } from "@/types/env";

const compression = compress({ threshold: 1024 });

function appendVary(headers: Headers, value: string): void {
  const values = (headers.get("Vary") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (values.includes("*")) {
    return;
  }

  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }

  headers.set("Vary", values.join(", "));
}

/**
 * Adds transport behavior needed by the Node/Cloud Run entrypoint while the
 * inner app remains independently request-testable.
 */
export function createNodeHttpApp(app: Hono<{ Bindings: Env }>): Hono<{ Bindings: Env }> {
  const nodeApp = new Hono<{ Bindings: Env }>();

  nodeApp.use("*", async (c, next) => {
    await next();
    appendVary(c.res.headers, "Accept-Encoding");
  });
  nodeApp.use("*", compression);
  nodeApp.route("/", app);

  return nodeApp;
}
