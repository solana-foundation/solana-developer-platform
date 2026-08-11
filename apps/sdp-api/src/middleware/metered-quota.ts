/**
 * Metered quotas for endpoints that spend money or fan out to paid upstreams
 * (Google Places, compliance vendors, ramp providers, Helius RPC).
 *
 * Layers on top of the general per-key/per-IP limiter with two differences:
 * counters are tenant- and actor-scoped (so one org — or one actor inside an
 * org — cannot exhaust a shared pool), and storage errors fail closed (an
 * unmetered request to a paid upstream is worse than a refused one).
 */

import type { Context, Next } from "hono";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { enforceRateLimit } from "./rate-limit";

export interface MeteredQuotaConfig {
  /** Stable name namespacing the counters, e.g. "places". */
  name: string;
  /** Max admitted requests per window for one actor (API key or user). */
  actorMax: number;
  /** Max admitted requests per window for the whole organization. */
  orgMax: number;
}

/**
 * Enforces the actor and org quotas for one metered operation. Requires an
 * auth context (run after unifiedAuthMiddleware) and c.var.kv (run on paths
 * kvStoreMiddleware covers).
 *
 * The actor counter is checked first: when a single actor is over its share,
 * the rejection must not consume the org-wide pool the other actors are
 * drawing from. The org counter is then charged on actor admission; an
 * org-level rejection leaves the actor counter slightly overcounted, which
 * only under-admits.
 *
 * Reads identity from the auth context (set by the auth middleware from the
 * verified API key / Clerk JWT / session cookie), never from request input.
 *
 * @param c - Request context with auth and kv populated.
 * @param config - Counter namespace and per-window ceilings.
 * @throws AppError RATE_LIMITED (429) when either quota is exhausted;
 *   AppError SERVICE_UNAVAILABLE (503) when the counter store is down.
 */
export async function enforceMeteredQuota(
  c: Context<{ Bindings: Env }>,
  config: MeteredQuotaConfig
): Promise<void> {
  const auth = getAuth(c);

  const actor = auth.authType === "api_key" ? `key:${auth.apiKeyId}` : `user:${auth.userId}`;
  const orgScope = `metered:${config.name}:org:${auth.organizationId}`;

  try {
    await enforceRateLimit(c, `${orgScope}:${actor}`, config.actorMax, { failClosed: true });
    await enforceRateLimit(c, orgScope, config.orgMax, { failClosed: true });
  } catch (error) {
    if (error instanceof AppError) {
      getLogger().warn(
        {
          event: "sdp_api_metered_quota",
          quota: config.name,
          decision: error.code === "RATE_LIMITED" ? "rejected" : "failed_closed",
          organization_id: auth.organizationId,
          actor,
          auth_type: auth.authType,
        },
        "Metered quota refused request"
      );
    }
    throw error;
  }
}

/**
 * Route middleware wrapper around enforceMeteredQuota, for endpoints where
 * every request is metered. Handlers that only sometimes take the costly
 * path (e.g. transfer listing with observed lookups) call
 * enforceMeteredQuota inline instead.
 *
 * @param config - Counter namespace and per-window ceilings.
 * @returns Hono middleware that admits, 429s, or 503s before calling next.
 */
export function meteredQuota(config: MeteredQuotaConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await enforceMeteredQuota(c, config);
    await next();
  };
}
