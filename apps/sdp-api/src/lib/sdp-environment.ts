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
 * Anonymous routes have no project, so they fall back to deployment-owned
 * configuration: SDP_ENVIRONMENT when explicitly set, otherwise the validated
 * runtime mapping (development -> sandbox, production -> production). Caller
 * input never participates. Unknown deployment values still fail closed.
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

  return resolveAnonymousSdpEnvironment(c.env);
}

/**
 * Resolves the deployment-owned environment used by keyless Earn requests.
 * Kept independent of Hono so startup can validate and report the same value
 * before accepting traffic.
 */
export function resolveAnonymousSdpEnvironment(
  env: Pick<Env, "SDP_ENVIRONMENT" | "ENVIRONMENT">
): SdpEnvironment {
  const deploymentEnvironment = env.SDP_ENVIRONMENT?.trim();
  if (deploymentEnvironment) {
    if (deploymentEnvironment === "sandbox" || deploymentEnvironment === "production") {
      return deploymentEnvironment;
    }
    throw internalError("SDP_ENVIRONMENT must be sandbox or production");
  }

  if (env.ENVIRONMENT === "development") {
    return "sandbox";
  }
  if (env.ENVIRONMENT === "production") {
    return "production";
  }

  throw internalError("Deployment environment could not be resolved");
}
