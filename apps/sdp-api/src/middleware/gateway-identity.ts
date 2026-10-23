import type { Context, Next } from "hono";
import { AppError } from "@/lib/errors";
import {
  GATEWAY_IDENTITY_HEADER,
  GatewayKeysUnavailableError,
  resolveGatewayIdentityConfig,
  verifyGatewayIdentity,
} from "@/lib/gateway-identity";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

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

    try {
      c.set("gatewayIdentity", await verifyGatewayIdentity(token, config));
    } catch (error) {
      if (error instanceof GatewayKeysUnavailableError) {
        getLogger().error({ error }, "Gateway signing keys are unavailable");
        throw new AppError("SERVICE_UNAVAILABLE", "Gateway identity cannot be verified right now");
      }
      throw new AppError("UNAUTHORIZED", "Invalid gateway identity");
    }
    await next();
  };
}
