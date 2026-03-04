/**
 * SDP API - Cloudflare Workers Entry Point
 *
 * Solana Developer Platform API
 * Built with Hono, D1, and KV
 */

import * as Sentry from "@sentry/cloudflare";
import { type Context, Hono } from "hono";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";

import { AppError } from "@/lib/errors";
import { corsMiddleware } from "@/middleware/cors";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { requestIdMiddleware } from "@/middleware/request-id";
import type { Env } from "@/types/env";

import allowlist from "@/routes/allowlist";
import apiKeys from "@/routes/api-keys";
import auth from "@/routes/auth";
import compliance from "@/routes/compliance";
import wallets from "@/routes/custody";
import docs from "@/routes/docs";
// Routes
import health from "@/routes/health";
import issuance from "@/routes/issuance";
import members from "@/routes/members";
import onboarding from "@/routes/onboarding";
import openapi from "@/routes/openapi";
import organizations from "@/routes/organizations";
import payments from "@/routes/payments";
import projects from "@/routes/projects";
import rpc from "@/routes/rpc";
import webhooks from "@/routes/webhooks";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";

// Create app
const app = new Hono<{ Bindings: Env }>();

const SENTRY_PENDING_TRANSFERS_MONITOR = "sdp-api-track-pending-transfers";
const PENDING_TRANSFERS_CRON = "* * * * *";

function parseSentryTraceSampleRate(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }

  return parsed;
}

function getSentryOptions(env: Env) {
  const dsn = env.SENTRY_DSN?.trim();
  const defaultTraceSampleRate = env.ENVIRONMENT === "production" ? 0.1 : 1;
  const tracesSampleRate = parseSentryTraceSampleRate(
    env.SENTRY_TRACES_SAMPLE_RATE,
    defaultTraceSampleRate
  );

  return {
    ...(dsn ? { dsn } : {}),
    enabled: Boolean(dsn),
    environment: env.ENVIRONMENT,
    tracesSampleRate,
    sendDefaultPii: false,
  };
}

function captureUnexpectedError(err: Error, c: Context<{ Bindings: Env }>): void {
  if (!c.env.SENTRY_DSN) {
    return;
  }

  const requestId = c.get("requestId");
  const path = new URL(c.req.url).pathname;

  Sentry.withScope((scope) => {
    scope.setTag("request_id", requestId);
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
      scope.setUser({ id: clerk.userId, email: clerk.email ?? undefined });
    }

    Sentry.captureException(err);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Global Middleware
// ═══════════════════════════════════════════════════════════════════════════

// Request ID for tracing
app.use("*", requestIdMiddleware());

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

// Rate limiting (skip health check paths)
app.use("*", skipRateLimitPaths("/health", "/health/ready", "/openapi.json", "/docs", "/webhooks"));

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

// Health check (no auth)
app.route("/health", health);
app.route("/openapi.json", openapi);
app.route("/docs", docs);
app.route("/webhooks", webhooks);

// API v1
const v1 = new Hono<{ Bindings: Env }>();
v1.route("/organizations", organizations);
v1.route("/api-keys", apiKeys);
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

  if (err instanceof AppError) {
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

  // Log unexpected errors
  console.error("Unexpected error:", {
    requestId,
    error: err.message,
    stack: err.stack,
  });
  captureUnexpectedError(err, c);

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

// ═══════════════════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════════════════

// Attach the scheduled handler to the Hono app so Cloudflare Workers can
// invoke it for cron triggers, while preserving app.request() for tests.
const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const runPendingTransferTracking = () => trackPendingTransfers(env);
    if (!env.SENTRY_DSN) {
      ctx.waitUntil(runPendingTransferTracking());
      return;
    }

    ctx.waitUntil(
      Sentry.withMonitor(SENTRY_PENDING_TRANSFERS_MONITOR, runPendingTransferTracking, {
        schedule: {
          type: "crontab",
          value: PENDING_TRANSFERS_CRON,
        },
      })
    );
  },
  request: app.request.bind(app),
} satisfies ExportedHandler<Env> & {
  request: typeof app.request;
};

export default Sentry.withSentry(getSentryOptions, worker);
