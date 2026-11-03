import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Context } from "hono";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { createEarnRepository } from "@/db/repositories/repository-factory";
import { notFound } from "@/lib/errors";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * Loads the strategy a route names in the open cluster scope's environment, which the project
 * middleware opened for the caller's project. A row from another environment is 404, never a
 * cross-tier answer.
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
  const { environment } = currentClusterScope();
  const strategy = await getEarnRepository(c).getStrategyById(strategyId);
  if (!strategy || strategy.environment !== environment) throw notFound("Earn strategy");
  return { strategy, environment };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
