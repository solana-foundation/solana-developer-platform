import type { EgressReadiness } from "@sdp/types/health";
import type { SdpRampProviderMaturity } from "@sdp/types/release-channels";
/**
 * SDP API — Hono application factory.
 *
 * `createApp(deps)` builds the Hono instance with all middleware, routes, and
 * error handling wired up, while transport and process lifecycle concerns stay
 * in `server.ts`.
 */

import { SigningError, type SigningErrorCode } from "@sdp/custody/signing";
import { SdpEarnError } from "@sdp/earn/errors";
import { FeePaymentError } from "@sdp/fee-payment/port";
import { SdpPaymentsError } from "@sdp/payments/errors";
import { redactCredentialSecrets, redactCredentialString } from "@sdp/redaction/credentials";
import { scrubTelemetry } from "@sdp/redaction/scrub";
import { RpcUnavailableError, SdpRpcError } from "@sdp/rpc/errors";
import { isRpcUpstreamUnavailable } from "@sdp/rpc/transient";
import type { RpcUnavailableReason } from "@sdp/types/rpc";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { DatabaseUnavailableError } from "@/db/client";
import {
  AppError,
  badRequest,
  type ErrorCode,
  internalError,
  payloadTooLarge,
  serviceUnavailable,
} from "@/lib/errors";
import { appErrorResponse, errorResponse, mapErrorStatusCode } from "@/lib/response";
import { corsMiddleware } from "@/middleware/cors";
import { databaseIdentityBoundary } from "@/middleware/database-identity";
import { gatewayIdentityMiddleware } from "@/middleware/gateway-identity";
import { idempotencyKeyMiddleware } from "@/middleware/idempotency-key";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { requestIdMiddleware } from "@/middleware/request-id";
import { requestTracingMiddleware } from "@/middleware/request-tracing";
import { publicRoute } from "@/middleware/require-action";
import { requireModule } from "@/middleware/require-module";
import { allowlist } from "@/routes/allowlist";
import { apiKeys } from "@/routes/api-keys";
import { assetProfiles } from "@/routes/asset-profiles";
import { compliance } from "@/routes/compliance";
import { counterparties } from "@/routes/counterparties";
import { wallets } from "@/routes/custody";
import { internalWallets } from "@/routes/custody/internal";
import { docs } from "@/routes/docs";
import { dvp } from "@/routes/dvp";
import { earnRoutes as earn } from "@/routes/earn";
import { health } from "@/routes/health";
import { heliusRings } from "@/routes/helius-rings";
import { integrations } from "@/routes/integrations";
import { internalCustody } from "@/routes/internal-custody";
import { internalFireblocks } from "@/routes/internal-fireblocks";
import { internalHeliusRings } from "@/routes/internal-helius-rings";
import { internalNetwork } from "@/routes/internal-network";
import { issuance } from "@/routes/issuance";
import { llms } from "@/routes/llms";
import { members } from "@/routes/members";
import { onboarding } from "@/routes/onboarding";
import { openapi } from "@/routes/openapi";
import { organizations } from "@/routes/organizations";
import { pay } from "@/routes/pay";
import { payments } from "@/routes/payments";
import { places } from "@/routes/places";
import { privateChannels } from "@/routes/private-channels";
import { projects } from "@/routes/projects";
import { transactions } from "@/routes/transactions";
import { webhooks } from "@/routes/webhooks";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent, paymentsErrorDiagnostics } from "@/runtime/money-path-events";
import { mapFeePaymentError } from "@/services/fee-payment-errors";
import type { Env } from "@/types/env";

export interface SdpPlugin {
  name: string;
  register(app: Hono<{ Bindings: Env }>): void;
}

export interface AppDeps {
  plugins?: SdpPlugin[];
  /**
   * Ramp provider stages to run the release channel against. Production passes
   * `SDP_RAMP_PROVIDER_MATURITY`; tests may put one provider in a release channel and
   * leave another out, which today's all-`experimental` stages cannot show.
   */
  rampProviderMaturity: SdpRampProviderMaturity;
  /**
   * The Node entrypoint's egress gate, so `/health/ready` keeps a fresh instance
   * out of rotation until it can reach the internet. Absent where nothing gates
   * on egress (the Workers entrypoint, tests).
   */
  egressReadiness?: () => EgressReadiness;
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

// Backstop bound for any /v1 request body. Handler-side schemas are far
// smaller; the webhooks router already enforces this same ceiling on its
// subset, and no public /v1 route accepts file uploads.
const MAX_API_BODY_BYTES = 1024 * 1024;

// Bound for any /pay request body. The only body /pay reads is the Solana Pay
// transaction request (`transactionRequestBodySchema`: one account address),
// tens of bytes; the unauthenticated surface gets no more room than that needs.
const MAX_PAY_BODY_BYTES = 4 * 1024;

/**
 * The `ErrorCode` a custody signing failure that reaches the handler answers, never the custody
 * package's own code. It answers at that code's own status, so a signing error and an `AppError`
 * with the same code never disagree. The signer waist (`admittedSigner`) turns a policy refusal
 * into `CUSTODY_POLICY_REFUSED` naming the provider; that row here covers one that arrives any
 * other way.
 */
const SIGNING_ERROR_CODES = {
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  WALLET_NOT_FOUND: "NOT_FOUND",
  NOT_FOUND: "NOT_FOUND",
  INVALID_REQUEST: "BAD_REQUEST",
  PROVIDER_CREDENTIAL_INVALID: "BAD_REQUEST",
  ALREADY_INITIALIZED: "CONFLICT",
  CONFLICT: "CONFLICT",
  POLICY_REFUSED: "CUSTODY_POLICY_REFUSED",
  NETWORK_ERROR: "CUSTODY_ERROR",
} as const satisfies Record<SigningErrorCode, ErrorCode>;

function getSafeSigningErrorMessage(err: SigningError): string {
  switch (err.code) {
    case "NETWORK_ERROR":
      return "The signing provider could not complete the request. Check provider status and try again.";
    case "PROVIDER_NOT_CONFIGURED":
      return "The signing provider is not configured. Check provider configuration and try again.";
    default:
      return redactCredentialString(err.message);
  }
}

/**
 * The answer for a Fireblocks `BLOCKED` that is not a confirmed policy refusal (the adapter turns
 * that one into a `SigningError`), or `null` for any other error.
 */
function getFireblocksBlockedError(err: Error): AppError | null {
  if (!err.message.includes("Transaction failed with status: BLOCKED")) {
    return null;
  }

  return new AppError(
    "SIGNING_BLOCKED",
    "Fireblocks blocked this signing request. Confirm raw signing is enabled for this workspace and that the raw-signing policy allows this API user and vault."
  );
}

/** How long a client is told to wait after Solana RPC was unavailable upstream. */
const RPC_UNAVAILABLE_RETRY_AFTER_SECONDS = 2;

/**
 * Why `err` means Solana RPC is unavailable, or `null` when it doesn't: the pool's own
 * `RpcUnavailableError`, or a transient failure from RPC itself (provider 429/5xx, a JSON-RPC
 * timeout, SDP's attempt deadline) that reached the boundary uncaught.
 */
function rpcUnavailableFor(
  err: Error
): { reason: RpcUnavailableReason; cluster: SolanaCluster | undefined } | null {
  if (err instanceof RpcUnavailableError) return { reason: err.reason, cluster: err.cluster };
  return isRpcUpstreamUnavailable(err)
    ? { reason: "upstream_unavailable", cluster: undefined }
    : null;
}

/**
 * One `503 RPC_UNAVAILABLE` for every way RPC can be unavailable, with `details: { reason,
 * cluster }` so a client can tell "retry later" from "this won't work". Only
 * `upstream_unavailable` is transient, so only it carries `Retry-After`. The body never repeats
 * the thrown message, which can name env keys and genesis hashes; operators read those in the log.
 */
function rpcUnavailableResponse(
  c: Context<{ Bindings: Env }>,
  { reason, cluster: thrownCluster }: NonNullable<ReturnType<typeof rpcUnavailableFor>>
): Response {
  const environment = c.get("projectEnvironment");
  const cluster =
    environment === undefined ? thrownCluster : CLUSTER_BY_SDP_ENVIRONMENT[environment];
  if (reason === "upstream_unavailable") {
    c.header("Retry-After", String(RPC_UNAVAILABLE_RETRY_AFTER_SECONDS));
  }
  return errorResponse(c, 503, {
    code: "RPC_UNAVAILABLE",
    message:
      reason === "upstream_unavailable"
        ? "Solana RPC is temporarily unavailable. Retry after the Retry-After delay."
        : "Solana RPC is not available for this environment.",
    details: { reason, cluster },
  });
}

type SdkError = SdpRpcError | SdpPaymentsError | SdpEarnError;

/**
 * The `ErrorCode` an SDK error answers with, or `null` for a cluster scope error: that is SDP's
 * own wiring bug, so it gets the unexpected-error 500 and its stack in the log. The switch is
 * exhaustive, so a new SDK code `ErrorCode` lacks fails to compile here.
 */
function sdkErrorCode(code: SdkError["code"]): ErrorCode | null {
  switch (code) {
    case "CLUSTER_SCOPE_MISSING":
    case "CLUSTER_SCOPE_CONFLICT":
      return null;
    default:
      return code;
  }
}

/**
 * The response for an error thrown by an SDP SDK (`@sdp/rpc`, `@sdp/payments`, `@sdp/earn`), or
 * `null` when `err` is none of theirs or is a cluster scope error. RPC unavailability, including a
 * transient kit error that reached the boundary uncaught, is one `503 RPC_UNAVAILABLE`; any other
 * SDK error answers its own code and status.
 *
 * @param c - The request context.
 * @param err - The thrown error.
 * @param path - The matched route, for the log.
 * @param logVendorError - Logs the `sdp_api_vendor_error` event for `err`.
 */
function sdkErrorResponse(
  c: Context<{ Bindings: Env }>,
  err: Error,
  path: string,
  logVendorError: (vendor: string, code: string, status: number) => void
): Response | null {
  const rpcUnavailable = rpcUnavailableFor(err);
  if (rpcUnavailable !== null) {
    logVendorError("rpc", "RPC_UNAVAILABLE", 503);
    return rpcUnavailableResponse(c, rpcUnavailable);
  }
  if (
    !(err instanceof SdpRpcError || err instanceof SdpPaymentsError || err instanceof SdpEarnError)
  ) {
    return null;
  }
  const code = sdkErrorCode(err.code);
  if (code === null) return null;
  const requestId = c.get("requestId");
  if (err instanceof SdpRpcError) {
    logVendorError("rpc", err.code, err.statusCode);
  }
  // The provider's own wording never reaches the body below; operators read
  // it here. Its own event, so it stays out of the vendor-error alert, which
  // leaves ramps to sdp_api_ramp_provider_error.
  if (err instanceof SdpPaymentsError && err.diagnostics !== undefined) {
    logEvent(err.statusCode >= 500 ? "error" : "warn", {
      event: "sdp_api_payments_provider_error",
      code: err.code,
      status: err.statusCode,
      method: c.req.method,
      path,
      request_id: requestId,
      ...describeError(err),
      error_diagnostics: paymentsErrorDiagnostics(err),
    });
  }
  const details = err.details ? redactCredentialSecrets(err.details) : undefined;
  return errorResponse(c, mapErrorStatusCode(err.statusCode), {
    code,
    message: redactCredentialString(err.message),
    ...(details && { details }),
  });
}

/** How long a client is told to wait after the database could not take its request. */
const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 2;

/**
 * The response for an error nothing else recognized, after it was logged. A
 * database with no connection to give is the one retryable case: a 503 with
 * `Retry-After` tells the client to back off where a 500 told it the API was
 * broken. It is still logged as an unexpected error, with the pool counters in
 * the message, so the alert on those keeps seeing a saturated pool.
 */
function unexpectedErrorResponse(c: Context<{ Bindings: Env }>, err: Error): Response {
  if (err instanceof DatabaseUnavailableError) {
    c.header("Retry-After", String(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS));
    return appErrorResponse(c, serviceUnavailable());
  }
  return appErrorResponse(c, internalError());
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // ═══════════════════════════════════════════════════════════════════════════
  // Global Middleware
  // ═══════════════════════════════════════════════════════════════════════════

  app.use("*", async (c, next) => {
    c.set("rampProviderMaturity", deps.rampProviderMaturity);
    c.set("egressReadiness", deps.egressReadiness);
    await next();
  });

  // Request ID for tracing
  app.use("*", requestIdMiddleware());

  // The gateway's signed caller identity, before anything reads the caller or
  // its address (rate limits, auth, IP allowlists).
  app.use("*", gatewayIdentityMiddleware());

  // Database identity boundary: public surfaces run as named system
  // components, everything else is identity-less until an auth middleware
  // narrows it to a tenant — row-level security denies unwired access.
  app.use("*", databaseIdentityBoundary());

  // Idempotency-Key validation + response echo (public API only)
  app.use("/v1/*", idempotencyKeyMiddleware());

  // Backstop body bound for the whole public API: request handlers buffer the
  // body whole before zod validation runs, so without a ceiling a single
  // authenticated request could make the instance buffer unbounded bytes.
  // Route-level limits (webhooks) are equal or stricter.
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      onError: () => {
        throw payloadTooLarge();
      },
    })
  );
  app.use(
    "/pay/*",
    bodyLimit({
      maxSize: MAX_PAY_BODY_BYTES,
      onError: () => {
        throw payloadTooLarge();
      },
    })
  );

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

  // KV store — populates c.var.kv. Must precede rate-limit and auth
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
  v1.route("/projects", projects);
  // Asset profiles live under the issuance namespace, as a sibling of
  // /issuance/tokens. The router is self-contained (own auth + feature-flag + project
  // middleware).
  v1.use("/issuance/*", requireModule("issuance"));
  v1.route("/issuance/asset-profiles", assetProfiles);
  v1.route("/issuance", issuance);
  v1.use("/wallets/*", requireModule("custody"));
  v1.route("/wallets", wallets);
  v1.route("/onboarding", onboarding);
  v1.route("/payments", payments);
  v1.route("/transactions", transactions);
  // The release channel alone decides Earn and DvP; a module outside it gets the shared refusal.
  v1.use("/earn/*", requireModule("earn"));
  v1.route("/earn", earn);
  v1.use("/dvp/*", requireModule("dvp"));
  v1.route("/dvp", dvp);
  v1.route("/places", places);
  v1.route("/integrations", integrations);
  v1.use("/private-channels/*", requireModule("private_channels"));
  v1.route("/private-channels", privateChannels);
  v1.use("/helius-rings/*", requireModule("helius_rings"));
  v1.route("/helius-rings", heliusRings);
  v1.use("/compliance/*", requireModule("compliance"));
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
  app.use("/internal/dashboard/custody/*", requireModule("custody"));
  app.route("/internal/dashboard/custody", internalCustody);
  app.use("/internal/dashboard/wallets/*", requireModule("custody"));
  app.route("/internal/dashboard/wallets", internalWallets);
  app.use("/internal/dashboard/fireblocks/*", requireModule("custody"));
  app.route("/internal/dashboard/fireblocks", internalFireblocks);
  app.use("/internal/dashboard/helius-rings/*", requireModule("helius_rings"));
  app.route("/internal/dashboard/helius-rings", internalHeliusRings);
  app.route("/internal/dashboard/network", internalNetwork);

  // Admin routes (internal)
  app.route("/admin/allowlist", allowlist);

  // Root redirect to health
  app.get("/", publicRoute("root: redirects to the health check"), (c) => c.redirect("/health"));

  // ═══════════════════════════════════════════════════════════════════════════
  // Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    const traceId = c.get("traceId");
    const requestSource = c.get("requestSource");
    const path = routePath(c, -1) || "unmatched";

    const logVendorError = (vendor: string, code: string, status: number) =>
      logEvent("error", {
        event: "sdp_api_vendor_error",
        vendor,
        code,
        status,
        method: c.req.method,
        path,
        request_id: requestId,
        ...describeError(err),
      });

    // Hono core throws HTTPException(400) for malformed JSON bodies before
    // route-level body validation runs; normalize it into the AppError envelope.
    const normalizedError =
      err instanceof HTTPException && err.status === 400 ? badRequest(err.message) : err;

    if (normalizedError instanceof AppError) {
      return appErrorResponse(c, normalizedError);
    }

    const sdkResponse = sdkErrorResponse(c, err, path, logVendorError);
    if (sdkResponse !== null) return sdkResponse;

    if (err instanceof SigningError) {
      const signingError = new AppError(
        SIGNING_ERROR_CODES[err.code],
        getSafeSigningErrorMessage(err)
      );
      // The custody package's own code, which the response no longer names.
      logVendorError("signing", err.code, signingError.statusCode);
      return appErrorResponse(c, signingError);
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
      return errorResponse(c, mapped.status, { code: mapped.code, message: mapped.message });
    }

    const fireblocksBlocked = getFireblocksBlockedError(err);
    if (fireblocksBlocked) {
      logVendorError("fireblocks", fireblocksBlocked.code, fireblocksBlocked.statusCode);
      return appErrorResponse(c, fireblocksBlocked);
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
      path,
      request_id: requestId,
      ...describeError(err),
    });
    // Scrubbed here as well as by the logger's own hook: this is the one log
    // line that carries a wholly unknown error, including `context` and `cause`
    // straight from a third-party SDK, so it does not rely on the sink alone.
    getLogger().error(
      scrubTelemetry({
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

    return unexpectedErrorResponse(c, err);
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
