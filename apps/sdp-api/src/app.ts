/**
 * SDP API — runtime-neutral Hono app factory.
 *
 * `createApp(deps)` builds the Hono instance with all middleware, routes, and
 * error handling wired up, but takes runtime-specific concerns (observability)
 * as injected dependencies. Runtime-specific bindings and SDKs are owned by
 * the entrypoints (`index.ts` on Workers, `server.ts` on Node — HOO-511); this
 * file must not import them, so the same Hono instance can be reused across
 * both runtimes.
 */

import { type Context, Hono } from "hono";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";

import { AppError } from "@/lib/errors";
import { corsMiddleware } from "@/middleware/cors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { requestIdMiddleware } from "@/middleware/request-id";
import { requestTracingMiddleware } from "@/middleware/request-tracing";
import allowlist from "@/routes/allowlist";
import apiKeys from "@/routes/api-keys";
import auth from "@/routes/auth";
import compliance from "@/routes/compliance";
import counterparties from "@/routes/counterparties";
import wallets from "@/routes/custody";
import docs from "@/routes/docs";
import health from "@/routes/health";
import issuance from "@/routes/issuance";
import llms from "@/routes/llms";
import members from "@/routes/members";
import onboarding from "@/routes/onboarding";
import openapi from "@/routes/openapi";
import organizations from "@/routes/organizations";
import payments from "@/routes/payments";
import projects from "@/routes/projects";
import rpc from "@/routes/rpc";
import webhooks from "@/routes/webhooks";
import { isSentryEnabled, type Observability } from "@/runtime/observability";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";

export interface AppDeps {
  observability: Observability;
}

// Routes that need no KV bindings. Shared by kvStoreMiddleware (skip the
// throw-on-missing-binding) and skipRateLimitPaths (skip rate-limit's
// c.var.kv deref). Both middlewares use exact-or-segment-prefix matching,
// so listing `/` here only skips the root redirect, not the whole API.
const KV_FREE_PATHS = [
  "/",
  "/health",
  "/health/ready",
  "/openapi.json",
  "/docs",
  "/llms.txt",
  "/webhooks",
];

function mapSigningError(err: SigningError): {
  status: 400 | 404 | 409 | 502 | 504;
  code: string;
  message: string;
} {
  switch (err.code) {
    case "WALLET_NOT_FOUND":
    case "NOT_FOUND":
      return { status: 404, code: err.code, message: err.message };
    case "ALREADY_INITIALIZED":
      return { status: 409, code: err.code, message: err.message };
    case "APPROVAL_TIMEOUT":
      return { status: 504, code: err.code, message: err.message };
    case "APPROVAL_REJECTED":
      return { status: 409, code: err.code, message: err.message };
    case "NETWORK_ERROR":
    case "SIGNING_FAILED":
      return { status: 502, code: err.code, message: err.message };
    default:
      return { status: 400, code: err.code, message: err.message };
  }
}

function getFireblocksBlockedError(err: Error): {
  status: 400;
  code: "SIGNING_BLOCKED";
  message: string;
} | null {
  if (!err.message.includes("Transaction failed with status: BLOCKED")) {
    return null;
  }

  return {
    status: 400,
    code: "SIGNING_BLOCKED",
    message:
      "Fireblocks blocked this signing request. Confirm raw signing is enabled for this workspace and that the raw-signing policy allows this API user and vault.",
  };
}

function captureUnexpectedError(
  observability: Observability,
  err: Error,
  c: Context<{ Bindings: Env }>
): void {
  const requestId = c.get("requestId");
  const traceId = c.get("traceId");
  const requestSource = c.get("requestSource");
  const path = new URL(c.req.url).pathname;

  observability.withScope((scope) => {
    scope.setTag("request_id", requestId);
    scope.setTag("trace_id", traceId);
    scope.setTag("request_source", requestSource);
    scope.setTag("http_method", c.req.method);
    scope.setTag("http_path", path);

    const apiKey = c.get("apiKey");
    const session = c.get("session");
    const clerk = c.get("clerk");

    if (apiKey) {
      scope.setTag("auth_type", "api_key");
      scope.setTag("organization_id", apiKey.organizationId);
      if (apiKey.projectId) {
        scope.setTag("project_id", apiKey.projectId);
      }
      scope.setUser({ id: `api_key:${apiKey.id}` });
    } else if (session) {
      scope.setTag("auth_type", "session");
      scope.setTag("organization_id", session.organizationId);
      scope.setUser({ id: session.userId });
    } else if (clerk) {
      scope.setTag("auth_type", "clerk");
      scope.setTag("organization_id", clerk.organizationId);
      if (clerk.orgSlug) {
        scope.setTag("organization_slug", clerk.orgSlug);
      }
      scope.setUser({ id: clerk.userId });
    }

    observability.captureException(err);
  });
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // ═══════════════════════════════════════════════════════════════════════════
  // Global Middleware
  // ═══════════════════════════════════════════════════════════════════════════

  // Request ID for tracing
  app.use("*", requestIdMiddleware());

  // Request trace + duration logging
  app.use("*", requestTracingMiddleware());

  // Security headers
  app.use("*", secureHeaders());

  // CORS (environment-aware)
  app.use("*", async (c, next) => {
    const cors = corsMiddleware(c.env.ENVIRONMENT);
    return cors(c, next);
  });

  // Pretty JSON in development
  app.use("*", async (c, next) => {
    if (c.env.ENVIRONMENT === "development") {
      return prettyJSON()(c, next);
    }
    return next();
  });

  // Logger in development
  app.use("*", async (c, next) => {
    if (c.env.ENVIRONMENT === "development") {
      return logger()(c, next);
    }
    return next();
  });

  // KV store — populates c.var.kv. Must precede rate-limit / auth / session
  // middleware (all of which read from c.var.kv).
  app.use("*", kvStoreMiddleware(...KV_FREE_PATHS));

  // Rate limiting (skip everything kvStoreMiddleware skipped, since rate-limit
  // dereferences c.var.kv without a guard).
  app.use("*", skipRateLimitPaths(...KV_FREE_PATHS));

  // ═══════════════════════════════════════════════════════════════════════════
  // Routes
  // ═══════════════════════════════════════════════════════════════════════════

  // Health check (no auth)
  app.route("/health", health);
  app.route("/openapi.json", openapi);
  app.route("/docs", docs);
  app.route("/llms.txt", llms);
  app.route("/webhooks", webhooks);

  // API v1
  const v1 = new Hono<{ Bindings: Env }>();
  v1.route("/organizations", organizations);
  v1.route("/api-keys", apiKeys);
  v1.route("/counterparties", counterparties);
  v1.route("/members", members);
  v1.route("/auth", auth);
  v1.route("/projects", projects);
  v1.route("/rpc", rpc);
  v1.route("/issuance", issuance);
  v1.route("/wallets", wallets);
  v1.route("/onboarding", onboarding);
  v1.route("/payments", payments);
  v1.route("/compliance", compliance);

  app.route("/v1", v1);

  // Admin routes (internal)
  app.route("/admin/allowlist", allowlist);

  // Root redirect to health
  app.get("/", (c) => c.redirect("/health"));

  // ═══════════════════════════════════════════════════════════════════════════
  // Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    const traceId = c.get("traceId");
    const requestSource = c.get("requestSource");

    if (err instanceof AppError) {
      c.header("X-SDP-Trace-ID", traceId);
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details && { details: err.details }),
          },
          meta: { requestId },
        },
        err.statusCode as 400
      );
    }

    if (err instanceof SigningError) {
      const mapped = mapSigningError(err);
      c.header("X-SDP-Trace-ID", traceId);
      return c.json(
        {
          error: {
            code: mapped.code,
            message: mapped.message,
          },
          meta: { requestId },
        },
        mapped.status
      );
    }

    const fireblocksBlocked = getFireblocksBlockedError(err);
    if (fireblocksBlocked) {
      c.header("X-SDP-Trace-ID", traceId);
      return c.json(
        {
          error: {
            code: fireblocksBlocked.code,
            message: fireblocksBlocked.message,
          },
          meta: { requestId },
        },
        fireblocksBlocked.status
      );
    }

    // Log unexpected errors
    console.error("Unexpected error:", {
      requestId,
      traceId,
      source: requestSource,
      error: err.message,
      stack: err.stack,
    });
    // SENTRY_DSN gate is the runtime-wiring decision: app-level error handling
    // shouldn't pay the cost of building a scope when no observability backend
    // is wired up. Kept at this seam (rather than inside captureUnexpectedError)
    // so the helper stays a pure scope-builder against the injected Observability.
    if (isSentryEnabled(c.env)) {
      captureUnexpectedError(deps.observability, err, c);
    }

    c.header("X-SDP-Trace-ID", traceId);
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred",
        },
        meta: { requestId },
      },
      500
    );
  });

  // 404 handler
  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
        },
        meta: { requestId: c.get("requestId") },
      },
      404
    );
  });

  return app;
}
