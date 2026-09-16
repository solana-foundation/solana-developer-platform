import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { createEarnRepository } from "@/db/repositories";
import { getOptionalAuth } from "@/lib/auth";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { Env } from "@/types/env";
import { resolveAnonymousEarnEnvironment } from "./environment";

export type AppContext = Context<{ Bindings: Env }>;

export { resolveSdpEnvironment } from "@/lib/sdp-environment";

/**
 * Resolves the environment for the narrow optional-auth Earn surface. Tenant
 * callers retain the project boundary; only a truly anonymous request maps the
 * deployment runtime to an Earn environment.
 */
export function resolveKeylessEarnEnvironment(c: AppContext): SdpEnvironment {
  if (getOptionalAuth(c)) {
    return resolveSdpEnvironment(c);
  }
  return resolveAnonymousEarnEnvironment(c.env.ENVIRONMENT);
}

export function earnRuntime(c: AppContext): EarnRuntimeContext {
  return { env: c.env, environment: resolveSdpEnvironment(c) };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
