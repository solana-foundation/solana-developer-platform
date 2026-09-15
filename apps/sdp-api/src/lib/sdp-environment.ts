import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { internalError } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Resolves the product environment (provider credentials, rail, and catalogue
 * scope) for the current request.
 *
 * Environment is a project boundary (migration 0005): API keys inherit it from
 * their project via the auth JOIN, and dashboard callers (Clerk or session
 * cookie) select a project with the x-project-id header, which
 * projectContextMiddleware verifies against project membership before setting
 * `projectEnvironment`. A production-project dashboard session therefore
 * resolves to production — the same rails as a production API key.
 *
 * Fails closed: a request whose environment cannot be resolved must never
 * default to either side. Defaulting to sandbox would point sandbox provider
 * credentials at production-project tenant rows; defaulting to production is
 * worse.
 */
export function resolveSdpEnvironment(c: Context<{ Bindings: Env }>): SdpEnvironment {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return apiKey.environment;
  }

  const projectEnvironment = c.get("projectEnvironment");
  if (projectEnvironment) {
    return projectEnvironment;
  }

  throw internalError("Request environment could not be resolved");
}
