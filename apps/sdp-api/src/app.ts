/**
 * SDP API — Hono application factory.
 *
 * `createApp(deps)` builds the Hono instance with all middleware, routes, and
 * error handling wired up, while transport and process lifecycle concerns stay
 * in `server.ts`. Observability remains injected so tests can use a lightweight
 * implementation without initializing the production SDK.
 */

import { redactCredentialSecrets, redactCredentialString } from "@sdp/custody";
import { SigningError } from "@sdp/custody/signing";
import { SdpEarnError } from "@sdp/earn/errors";
import { SdpPaymentsError } from "@sdp/payments/errors";
import { SdpRpcError } from "@sdp/rpc/errors";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, badRequest, redactErrorForCapture } from "@/lib/errors";
import { corsMiddleware } from "@/middleware/cors";
import { dryRunMiddleware } from "@/middleware/dry-run";
import { idempotencyKeyMiddleware } from "@/middleware/idempotency-key";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { requestIdMiddleware } from "@/middleware/request-id";
import { requestTracingMiddleware } from "@/middleware/request-tracing";
import allowlist from "@/routes/allowlist";
import apiKeys from "@/routes/api-keys";
import assetProfiles from "@/routes/asset-profiles";
import auth from "@/routes/auth";
import compliance from "@/routes/compliance";
import counterparties from "@/routes/counterparties";
import wallets from "@/routes/custody";
import docs from "@/routes/docs";
import earn from "@/routes/earn";
import health from "@/routes/health";
import heliusRings from "@/routes/helius-rings";
import internalCustody from "@/routes/internal-custody";
import internalRpc from "@/routes/internal-rpc";
import issuance from "@/routes/issuance";
import llms from "@/routes/llms";
import members from "@/routes/members";
import notifications from "@/routes/notifications";
import onboarding from "@/routes/onboarding";
import openapi from "@/routes/openapi";
import organizations from "@/routes/organizations";
import pay from "@/routes/pay";
import payments from "@/routes/payments";
import places from "@/routes/places";
import playgroundInternal from "@/routes/playground-internal";
import policies from "@/routes/policies";
import privateChannels from "@/routes/private-channels";
import projects from "@/routes/projects";
import rpc from "@/routes/rpc";
import webhooks from "@/routes/webhooks";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import type { Observability } from "@/runtime/observability";
import { FeePaymentError } from "@/services/ports";
import type { Env } from "@/types/env";

export interface SdpPlugin {
  name: string;
  register(app: Hono<{ Bindings: Env }>): void;
}

export interface AppDeps {
  observability: Observability;
  plugins?: SdpPlugin[];
}

// Routes that need no KV bindings. Shared by kvStoreMiddleware (skip the
// throw-on-missing-binding) and skipRateLimitPaths (skip rate-limit's
// c.var.kv deref). Both middlewares match via matchesFreePath (exact,
// segment-prefix, or single-segment `*` wildcard), so listing `/` here only
// skips the root redirect, not the whole API. The token-metadata entry frees
// only the public `metadata.json` route — the `*` matches exactly the token-id
// segment, so neither the sibling authed `/v1/issuance/tokens/:id/...` routes
// nor any future `/.../metadata.json` elsewhere are silently freed.
const KV_FREE_PATHS = [
  "/",
  "/health",
  "/health/ready",
  "/openapi.json",
  "/docs",
  "/llms.txt",
  "/webhooks",
  "/v1/issuance/tokens/*/metadata.json",
];

function mapErrorStatusCode(statusCode: number): ContentfulStatusCode {
  switch (statusCode) {
    case 202:
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 429:
    case 500:
    case 501:
    case 502:
    case 503:
      return statusCode;
    default:
      return 500;
  }
}

function mapSigningError(err: SigningError): {
  status: 400 | 404 | 409 | 502 | 504;
  code: string;
  message: string;
} {
  const message = getSafeSigningErrorMessage(err);
  switch (err.code) {
    case "WALLET_NOT_FOUND":
    case "NOT_FOUND":
      return { status: 404, code: err.code, message };
    case "ALREADY_INITIALIZED":
      return { status: 409, code: err.code, message };
    case "APPROVAL_TIMEOUT":
      return { status: 504, code: err.code, message };
    case "APPROVAL_REJECTED":
      return { status: 409, code: err.code, message };
    case "NETWORK_ERROR":
    case "SIGNING_FAILED":
      return { status: 502, code: err.code, message };
    default:
      return { status: 400, code: err.code, message };
  }
}

function getSafeSigningErrorMessage(err: SigningError): string {
  switch (err.code) {
    case "NETWORK_ERROR":
    case "SIGNING_FAILED":
      return "The signing provider could not complete the request. Check provider status and try again.";
    case "PROVIDER_NOT_CONFIGURED":
      return "The signing provider is not configured. Check provider configuration and try again.";
    default:
      return redactCredentialString(err.message);
  }
}

function mapFeePaymentError(err: FeePaymentError): {
  status: 400 | 429 | 502 | 503;
  code: string;
  message: string;
} {
  const programError = /custom program error: (0x[0-9a-f]+)/i.exec(err.message)?.[1].toLowerCase();
  if (programError === "0x1") {
    return {
      status: 400,
      code: "TRANSACTION_FAILED",
      message:
        "The wallet used for this payment does not have enough funds. Add funds and try again.",
    };
  }
  if (programError) {
    return {
      status: 400,
      code: "TRANSACTION_FAILED",
      message: "The transaction was rejected on Solana. Check the payment wallet and try again.",
    };
  }

  switch (err.code) {
    case "INSUFFICIENT_BALANCE":
      return {
        status: 400,
        code: "TRANSACTION_FAILED",
        message:
          "The wallet used for this payment does not have enough funds. Add funds and try again.",
      };
    case "RATE_LIMITED":
      return {
        status: 429,
        code: err.code,
        message: "The signing provider is busy. Try again.",
      };
    case "PROVIDER_NOT_AVAILABLE":
    case "NETWORK_ERROR":
      return {
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        message: "The signing provider is temporarily unavailable. Try again.",
      };
    default:
      return {
        status: 502,
        code: "TRANSACTION_FAILED",
        message: "The transaction could not be signed or submitted. Try again.",
      };
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

    observability.captureException(redactErrorForCapture(err));
  });
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // ═══════════════════════════════════════════════════════════════════════════
  // Global Middleware
  // ═══════════════════════════════════════════════════════════════════════════

  app.use("*", async (c, next) => {
    c.set("observability", deps.observability);
    await next();
  });

  // Request ID for tracing
  app.use("*", requestIdMiddleware());

  // Idempotency-Key validation + response echo (public API only)
  app.use("/v1/*", idempotencyKeyMiddleware());
  app.use("/v1/*", dryRunMiddleware());

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
  app.route("/pay", pay);

  // API v1
  const v1 = new Hono<{ Bindings: Env }>();
  v1.route("/organizations", organizations);
  v1.route("/api-keys", apiKeys);
  v1.route("/counterparties", counterparties);
  v1.route("/members", members);
  v1.route("/notifications", notifications);
  v1.route("/auth", auth);
  v1.route("/projects", projects);
  v1.route("/rpc", rpc);
  // Asset profiles live under the issuance namespace, as a sibling of
  // /issuance/tokens. The router is self-contained (own auth + feature-flag + project
  // middleware).
  v1.route("/issuance/asset-profiles", assetProfiles);
  v1.route("/issuance", issuance);
  v1.route("/wallets", wallets);
  v1.route("/onboarding", onboarding);
  v1.route("/payments", payments);
  v1.route("/earn", earn);
  v1.route("/places", places);
  v1.route("/policies", policies);
  v1.route("/private-channels", privateChannels);
  v1.route("/helius-rings", heliusRings);
  v1.route("/compliance", compliance);

  const registeredPluginNames = new Set<string>();
  for (const plugin of deps.plugins ?? []) {
    if (registeredPluginNames.has(plugin.name)) {
      throw new Error(`Duplicate plugin name: ${plugin.name}`);
    }
    registeredPluginNames.add(plugin.name);
    plugin.register(v1);
  }

  app.route("/v1", v1);

  // Dashboard-only helpers. These routes are intentionally excluded from the
  // public OpenAPI and AI discovery surfaces.
  app.route("/internal/playground", playgroundInternal);
  app.route("/internal/dashboard/custody", internalCustody);
  app.route("/internal/dashboard/rpc", internalRpc);

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

    const logVendorError = (vendor: string, code: string, status: number) =>
      logEvent("error", {
        event: "sdp_api_vendor_error",
        vendor,
        code,
        status,
        method: c.req.method,
        path: c.req.path,
        request_id: requestId,
        ...describeError(err),
      });

    // Hono core throws HTTPException(400) for malformed JSON bodies before
    // route-level body validation runs; normalize it into the AppError envelope.
    const normalizedError =
      err instanceof HTTPException && err.status === 400 ? badRequest(err.message) : err;

    if (normalizedError instanceof AppError) {
      c.header("X-SDP-Trace-ID", traceId);
      return c.json(
        {
          error: normalizedError.toResponse().error,
          meta: { requestId },
        },
        mapErrorStatusCode(normalizedError.statusCode)
      );
    }

    if (
      err instanceof SdpRpcError ||
      err instanceof SdpPaymentsError ||
      err instanceof SdpEarnError
    ) {
      if (err instanceof SdpRpcError) {
        logVendorError("rpc", err.code, err.statusCode);
      }
      const details = err.details ? redactCredentialSecrets(err.details) : undefined;
      c.header("X-SDP-Trace-ID", traceId);
      return c.json(
        {
          error: {
            code: err.code,
            message: redactCredentialString(err.message),
            ...(details && { details }),
          },
          meta: { requestId },
        },
        mapErrorStatusCode(err.statusCode)
      );
    }

    if (err instanceof SigningError) {
      const mapped = mapSigningError(err);
      logVendorError("signing", mapped.code, mapped.status);
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

    if (err instanceof FeePaymentError) {
      const mapped = mapFeePaymentError(err);
      logVendorError("fee-payment", err.code, mapped.status);
      // The response message is sanitized; without this log entry the actual
      // failure (breaker trip, provider outage, budget denial) is invisible.
      getLogger().warn(
        redactCredentialSecrets({
          requestId,
          traceId,
          source: requestSource,
          code: err.code,
          mapped_status: mapped.status,
          error: err.message,
          cause: err.cause?.message,
        }),
        "Fee payment error"
      );
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
      logVendorError("fireblocks", fireblocksBlocked.code, fireblocksBlocked.status);
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

    // Log unexpected errors. Include `context` and `cause` so SolanaError-style
    // failures (e.g. simulation errors with on-chain logs) surface enough detail
    // to diagnose from CI without a local repro.
    const solanaErr = err as Error & {
      context?: Record<string, unknown>;
      cause?: unknown;
    };
    logEvent("error", {
      event: "sdp_api_internal_error",
      method: c.req.method,
      path: c.req.path,
      request_id: requestId,
      ...describeError(err),
    });
    getLogger().error(
      redactCredentialSecrets({
        requestId,
        traceId,
        source: requestSource,
        error: err.message,
        stack: err.stack,
        context: solanaErr.context,
        cause: solanaErr.cause,
      }),
      "Unexpected error"
    );
    captureUnexpectedError(deps.observability, err, c);

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
