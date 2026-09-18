import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { createEarnRepository } from "@/db/repositories";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { getOptionalAuth } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export { resolveSdpEnvironment } from "@/lib/sdp-environment";

/**
 * The shelf an optional-auth catalogue read answers (PRO-1998).
 *
 * A tenant caller reads its project's environment and may not name another:
 * that would answer one tier with the other's rows. An anonymous caller has no
 * project, so the caller picks with `?environment=`; omitted, it reads the
 * production shelf, the one `api.solana.com` serves for real money. The
 * deployment's own `ENVIRONMENT` never enters: one process serves both
 * clusters, and a project or the caller says which.
 */
export function resolveEarnCatalogueEnvironment(
  c: AppContext,
  requested: SdpEnvironment | undefined
): SdpEnvironment {
  if (getOptionalAuth(c)) {
    const environment = resolveSdpEnvironment(c);
    if (requested !== undefined && requested !== environment) {
      throw badRequest(
        `environment follows the project on this key (${environment}); omit it or pass ${environment}.`
      );
    }
    return environment;
  }
  return requested ?? "production";
}

/**
 * Loads the strategy a keyless-capable money route names, with the environment
 * the request acts in. A tenant caller keeps the project boundary: a row from
 * another environment is 404, never a cross-tier answer. An anonymous caller
 * has no project, so the row IS the choice: its `environment` selects the
 * cluster, the RPC and the paymaster for this request (PRO-1998).
 */
export async function requireEarnStrategyForCaller(
  c: AppContext,
  strategyId: string
): Promise<{ strategy: EarnStrategyRow; environment: SdpEnvironment }> {
  const strategy = await getEarnRepository(c).getStrategyById(strategyId);
  if (!strategy) throw notFound("Earn strategy");
  if (getOptionalAuth(c)) {
    const environment = resolveSdpEnvironment(c);
    if (strategy.environment !== environment) throw notFound("Earn strategy");
    return { strategy, environment };
  }
  return { strategy, environment: strategy.environment };
}

export function earnRuntime(c: AppContext): EarnRuntimeContext {
  return { env: c.env, environment: resolveSdpEnvironment(c) };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
