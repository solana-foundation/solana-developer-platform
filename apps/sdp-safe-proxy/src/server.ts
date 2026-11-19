import { serve } from "@hono/node-server";
import { createApp } from "@/app";
import { createCallerResolver } from "@/caller";
import type { RequestLogLine } from "@/dispatch";
import { handlers } from "@/handlers";
import { readSettings } from "@/settings";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const LOG_SEVERITY = {
  ok: "INFO",
  rejected: "WARNING",
  no_answer: "ERROR",
} as const satisfies Record<RequestLogLine["outcome"], string>;

function logRequest(line: RequestLogLine): void {
  process.stdout.write(
    `${JSON.stringify({ severity: LOG_SEVERITY[line.outcome], message: "safe_proxy_request", ...line })}\n`
  );
}

const settings = readSettings(process.env);

const app = createApp({
  resolveCaller: createCallerResolver(settings),
  handlers,
  log: logRequest,
});

const server = serve({
  fetch: app.fetch,
  port: settings.port,
  hostname: settings.callerAuth === "local" ? "127.0.0.1" : "0.0.0.0",
});

function shutDown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
}
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
