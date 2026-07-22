import type { Env } from "@/types/env";

export type SdpDeploymentMode = "managed" | "self_hosted";

const VALID_DEPLOYMENT_MODES: ReadonlySet<string> = new Set<SdpDeploymentMode>([
  "managed",
  "self_hosted",
]);

const validatedDeploymentModes = new Map<string, SdpDeploymentMode>();

function resolveDeploymentMode(value: string | undefined): SdpDeploymentMode {
  if (value === undefined) {
    return "managed";
  }
  const cached = validatedDeploymentModes.get(value);
  if (cached !== undefined) {
    return cached;
  }
  if (!VALID_DEPLOYMENT_MODES.has(value)) {
    throw new Error(
      `Invalid SDP_DEPLOYMENT_MODE: "${value}". Expected "managed" or "self_hosted".`
    );
  }
  const resolved = value as SdpDeploymentMode;
  validatedDeploymentModes.set(value, resolved);
  return resolved;
}

export function getDeploymentMode(env: Pick<Env, "SDP_DEPLOYMENT_MODE">): SdpDeploymentMode {
  return resolveDeploymentMode(env.SDP_DEPLOYMENT_MODE);
}

export function isSelfHostedDeployment(env: Pick<Env, "SDP_DEPLOYMENT_MODE">): boolean {
  return resolveDeploymentMode(env.SDP_DEPLOYMENT_MODE) === "self_hosted";
}

/**
 * Return the complete Node process environment as SDP bindings.
 *
 * The API now runs exclusively on Node, so maintaining a second allowlist here
 * would only create drift with the deployment environment. Startup validation
 * remains responsible for required values; feature-specific readers handle
 * their optional values where they are consumed.
 */
export function getProcessEnv(): Env {
  return process.env as unknown as Env;
}
