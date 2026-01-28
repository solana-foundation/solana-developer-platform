/**
 * SDP API - Cloudflare Workers Entry Point
 *
 * Solana Developer Platform API
 * Built with Hono, D1, and KV
 */

import { Hono } from "hono";
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
import docs from "@/routes/docs";
// Routes
import health from "@/routes/health";
import issuance from "@/routes/issuance";
import members from "@/routes/members";
import openapi from "@/routes/openapi";
import organizations from "@/routes/organizations";
import projects from "@/routes/projects";
import transactions from "@/routes/transactions";

// Create app
const app = new Hono<{ Bindings: Env }>();

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
app.use("*", skipRateLimitPaths("/health", "/health/ready", "/openapi.json", "/docs"));

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

// Health check (no auth)
app.route("/health", health);
app.route("/openapi.json", openapi);
app.route("/docs", docs);

// API v1
const v1 = new Hono<{ Bindings: Env }>();
v1.route("/organizations", organizations);
v1.route("/api-keys", apiKeys);
v1.route("/members", members);
v1.route("/auth", auth);
v1.route("/projects", projects);
v1.route("/issuance", issuance);
v1.route("/transactions", transactions);

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

export default app;
