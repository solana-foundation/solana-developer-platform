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
/**
 * Ephemeral per-PR environments mount the same dev secrets but must land on
 * their own database and Redis keyspace. EPHEMERAL_DB_NAME and
 * EPHEMERAL_REDIS_DB rewrite the secret-provided URLs in place so every
 * downstream reader (API, worker, cron) sees the per-PR endpoints.
 */
export function applyEphemeralOverrides(env: NodeJS.ProcessEnv): void {
  const dbName = env.EPHEMERAL_DB_NAME?.trim();
  if (dbName && env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    url.pathname = `/${dbName}`;
    env.DATABASE_URL = url.toString();
  }
  const redisDb = env.EPHEMERAL_REDIS_DB?.trim();
  if (redisDb && env.REDIS_URL) {
    const url = new URL(env.REDIS_URL);
    url.pathname = `/${redisDb}`;
    env.REDIS_URL = url.toString();
  }
}

let ephemeralOverridesApplied = false;

export function getProcessEnv(): Env {
  if (!ephemeralOverridesApplied) {
    applyEphemeralOverrides(process.env);
    ephemeralOverridesApplied = true;
  }
  return process.env as unknown as Env;
}
