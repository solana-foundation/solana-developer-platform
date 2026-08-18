import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { Context } from "hono";
import { createEarnRepository } from "@/db/repositories";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export { resolveSdpEnvironment } from "@/lib/sdp-environment";

export function earnRuntime(c: AppContext): EarnRuntimeContext {
  return {
    env: c.env,
    environment: resolveSdpEnvironment(c),
  };
}

export function getEarnRepository(c: AppContext) {
  return createEarnRepository(c.env);
}
