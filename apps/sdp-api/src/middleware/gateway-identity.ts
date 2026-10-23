import type { Context, Next } from "hono";
import { resolveClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import {
  GATEWAY_IDENTITY_HEADER,
  GatewayKeysUnavailableError,
  resolveGatewayIdentityConfig,
  verifyGatewayIdentity,
} from "@/lib/gateway-identity";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { InProcessRateLimiter } from "./rate-limit";

/** Failed `X-SF-Identity` verifications one client IP may cause per window. */
const INVALID_IDENTITY_MAX_FAILURES = 20;
const INVALID_IDENTITY_WINDOW_MS = 60_000;
/** Where failures without a verified client address count, together. */
const UNVERIFIED_CLIENT_BUCKET = "unverified-client";

/**
 * Bounds signature checks on forged identities, which reach verification
 * before any request limit. It counts failures only, per the proxy-reported
 * client IP (never the token's own `client_ip`): the gateway's traffic shares
 * a few egress IPs, so a limit on every identity would throttle it. Gateway
 * mode requires TRUST_PROXY_HEADERS, so the address is known. Per
 * instance, in memory, so it needs no counter store before verification.
 */
export const invalidGatewayIdentityLimiter = new InProcessRateLimiter(
  "gateway_identity_invalid",
  10_000
);

/**
 * Reads the gateway's signed caller identity (HOO-2256) before anything that
 * needs the caller or its address: rate limiting, authentication, IP
 * allowlists.
 *
 * - No gateway configured: the header is caller-chosen and ignored.
 * - No header: the request reached SDP directly and authenticates as before.
 * - A header that does not verify: 401, never a fallback to the direct path.
 */
export function gatewayIdentityMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const token = c.req.header(GATEWAY_IDENTITY_HEADER);
    const config = token ? resolveGatewayIdentityConfig(c.env) : null;
    if (!token || !config) {
      await next();
      return;
    }

    // A request without a verified client address (one that bypassed the
    // trusted proxy) counts in one shared bucket, which can only refuse other
    // such requests: the gateway's own traffic always carries a verified one.
    const failureBucket =
      resolveClientIp({ get: (name) => c.req.header(name) ?? null }, c.env) ??
      UNVERIFIED_CLIENT_BUCKET;
    invalidGatewayIdentityLimiter.assertNotExhausted(
      c,
      failureBucket,
      INVALID_IDENTITY_MAX_FAILURES,
      INVALID_IDENTITY_WINDOW_MS
    );

    try {
      c.set("gatewayIdentity", await verifyGatewayIdentity(token, config));
    } catch (error) {
      if (error instanceof GatewayKeysUnavailableError) {
        getLogger().error({ error }, "Gateway signing keys are unavailable");
        throw new AppError("SERVICE_UNAVAILABLE", "Gateway identity cannot be verified right now");
      }
      // Counts the failure; the one that reaches the limit is refused as such.
      invalidGatewayIdentityLimiter.enforce(
        c,
        failureBucket,
        INVALID_IDENTITY_MAX_FAILURES,
        INVALID_IDENTITY_WINDOW_MS
      );
      throw new AppError("UNAUTHORIZED", "Invalid gateway identity");
    }
    await next();
  };
}
