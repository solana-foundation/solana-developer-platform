import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { internalError } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Resolves the product environment (provider credentials, rail, and catalogue
 * scope) for the current request.
 *
 * Environment is a project boundary (migration 0005). Only
 * `projectContextMiddleware` sets `projectEnvironment`, for every actor (API
 * key, dashboard, approved-operation replay), and only after it has refused a
 * production project whose organization lacks the production entitlement
 * (APE-351). There is deliberately no shortcut through the API key's own
 * environment: a router that forgot the middleware fails here, closed, instead
 * of reaching production unchecked.
 *
 * Fails closed: a request whose environment cannot be resolved must never
 * default to either side. Defaulting to sandbox would point sandbox provider
 * credentials at production-project tenant rows; defaulting to production is
 * worse.
 */
export function resolveSdpEnvironment(c: Context<{ Bindings: Env }>): SdpEnvironment {
  const projectEnvironment = c.get("projectEnvironment");
  if (projectEnvironment) {
    return projectEnvironment;
  }

  throw internalError("Request environment could not be resolved");
}
