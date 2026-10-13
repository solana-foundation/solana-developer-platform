import type { EarnRuntimeContext } from "@sdp/earn/types";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { createEarnRepository } from "@/db/repositories";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { conflict, notFound } from "@/lib/errors";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export { resolveSdpEnvironment } from "@/lib/sdp-environment";

/**
 * The shelf an optional-auth catalogue read answers (PRO-1998): the environment of the open
 * cluster scope. A tenant caller's scope is its project's, and naming another environment would
 * answer one tier with the other's rows. A keyless caller's scope was opened from the
 * `?environment=` it is required to name (index.ts), so the two always agree. The deployment's
 * own `ENVIRONMENT` never enters: one process serves both clusters.
 *
 * @param requested - The `?environment=` the caller named, if any.
 * @returns The environment the catalogue read answers.
 * @throws AppError `CONFLICT` when `requested` differs from the scope's environment.
 */
export function resolveEarnCatalogueEnvironment(
  requested: SdpEnvironment | undefined
): SdpEnvironment {
  const { environment } = currentClusterScope();
  if (requested !== undefined && requested !== environment) {
    throw conflict(
      `environment follows the project on this key (${environment}); omit it or pass ${environment}.`
    );
  }
  return environment;
}

/**
 * Loads the strategy a keyless-capable money route names, with the environment the request acts
 * in: the open cluster scope's. A tenant caller's scope is its project's, so a row from another
 * environment is 404, never a cross-tier answer. A keyless caller's scope was opened from this
 * same row's `environment` (index.ts), so the row IS the choice of cluster, RPC and paymaster
 * (PRO-1998).
 *
 * @param c - The request context.
 * @param strategyId - The catalogue strategy id the request names.
 * @returns The strategy row and the scope's environment.
 * @throws AppError `NOT_FOUND` when the row is absent or belongs to another environment.
 */
export async function requireEarnStrategyForCaller(
  c: AppContext,
  strategyId: string
): Promise<{ strategy: EarnStrategyRow; environment: SdpEnvironment }> {
  const strategy = await getEarnRepository(c).getStrategyById(strategyId);
  if (!strategy) throw notFound("Earn strategy");
  const { environment } = currentClusterScope();
  if (strategy.environment !== environment) throw notFound("Earn strategy");
  return { strategy, environment };
}

export function earnRuntime(c: AppContext): EarnRuntimeContext {
  return { env: c.env, environment: resolveSdpEnvironment(c) };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
