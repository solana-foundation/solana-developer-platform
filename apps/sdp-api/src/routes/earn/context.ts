import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { createEarnRepository } from "@/db/repositories";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * Resolves the product environment for provider credentials and the strategy
 * catalogue. API-key callers are scoped by the key; dashboard/session callers
 * default to sandbox while that is the only supported dashboard mode (same
 * rule as payments).
 */
export function resolveSdpEnvironment(c: AppContext): SdpEnvironment {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return apiKey.environment;
  }
  return "sandbox";
}

export function earnRuntime(c: AppContext): EarnRuntimeContext {
  return {
    env: c.env as unknown as Record<string, string | undefined>,
    mode: resolveSdpEnvironment(c),
  };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
