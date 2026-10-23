import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Context } from "hono";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { createEarnRepository } from "@/db/repositories/repository-factory";
import { notFound } from "@/lib/errors";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * Loads the strategy a route names in the caller's project environment. A row
 * from another environment is 404, never a cross-tier answer.
 *
 * @param c - The request context.
 * @param strategyId - The catalogue strategy id the request names.
 * @returns The strategy row and the project's environment.
 * @throws AppError `NOT_FOUND` when the row is absent or belongs to another environment.
 */
export async function requireEarnStrategyForCaller(
  c: AppContext,
  strategyId: string
): Promise<{ strategy: EarnStrategyRow; environment: SdpEnvironment }> {
  const environment = resolveSdpEnvironment(c);
  const strategy = await getEarnRepository(c).getStrategyById(strategyId);
  if (!strategy || strategy.environment !== environment) throw notFound("Earn strategy");
  return { strategy, environment };
}

export function earnRuntime(c: AppContext): EarnRuntimeContext {
  return { env: c.env, environment: resolveSdpEnvironment(c) };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
