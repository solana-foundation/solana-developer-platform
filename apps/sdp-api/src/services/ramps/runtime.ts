import { providerNotConfigured } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type {
  RampCredentialsResolution,
  RampProviderCredentials,
  RampRuntimeContext,
} from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { RampProviderId } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import type { Env } from "@/types/env";

/**
 * The env vars SDP's managed sandbox account keeps each provider's keys
 * under, listed in the order a missing-key refusal names them.
 */
const MANAGED_RAMP_KEYS = {
  moonpay: { publicKey: "MOONPAY_SANDBOX_API_KEY", secretKey: "MOONPAY_SANDBOX_SECRET_KEY" },
  stripe: { secretKey: "STRIPE_SANDBOX_SECRET_KEY", publicKey: "STRIPE_SANDBOX_PUBLISHABLE_KEY" },
} as const satisfies Record<RampProviderId, Record<keyof RampProviderCredentials, keyof Env>>;

type ManagedRampKeyName = (typeof MANAGED_RAMP_KEYS)[RampProviderId][keyof RampProviderCredentials];

/** The part of the environment SDP's managed ramp keys are read from. */
export type ManagedRampKeysEnv = Readonly<Partial<Record<ManagedRampKeyName, string>>>;

/**
 * SDP's managed keys for `provider` in `mode`, or why they can't serve it.
 * SDP holds sandbox keys only: a production project brings its own account
 * (HOO-1942, HOO-1943), so production fails closed until it can. The provider
 * then checks the keys fit the mode, so a live key mounted under the sandbox
 * names never reaches it. Availability, every provider call and rail
 * discovery read this, so they never disagree.
 *
 * @param env - Where the managed keys are mounted.
 * @param provider - The ramp provider.
 * @param mode - The mode the call runs in.
 * @returns The keys, or the refusal.
 */
export function resolveManagedRampCredentials(
  env: ManagedRampKeysEnv,
  provider: RampProviderId,
  mode: SdpEnvironment
): RampCredentialsResolution {
  const client = RAMP_PROVIDER_CLIENTS[provider];
  if (mode === "production") {
    return { ok: false, reason: `${client.label} is not configured for production projects.` };
  }
  const names = MANAGED_RAMP_KEYS[provider];
  const publicKey = env[names.publicKey]?.trim();
  const secretKey = env[names.secretKey]?.trim();
  if (!publicKey || !secretKey) {
    return {
      ok: false,
      reason: `${client.label} sandbox is not configured. Set ${Object.values(names).join(" and ")}.`,
    };
  }
  const credentials = { publicKey, secretKey };
  const refusal = client.checkCredentials(credentials, mode);
  return refusal === null ? { ok: true, credentials } : { ok: false, reason: refusal };
}

/**
 * The runtime one call to `provider` runs under in `mode`: the cluster the
 * mode picks, as the cluster scope derives it (ADR 0007), and SDP's keys.
 *
 * @param env - Where the managed keys are mounted.
 * @param provider - The ramp provider.
 * @param mode - The mode the call runs in.
 * @returns The runtime context.
 * @throws SdpPaymentsError PROVIDER_NOT_CONFIGURED when the keys can't serve `mode`.
 */
export function rampRuntimeFor(
  env: ManagedRampKeysEnv,
  provider: RampProviderId,
  mode: SdpEnvironment
): RampRuntimeContext {
  const resolution = resolveManagedRampCredentials(env, provider, mode);
  if (!resolution.ok) {
    throw providerNotConfigured(resolution.reason);
  }
  return { mode, cluster: CLUSTER_BY_SDP_ENVIRONMENT[mode], credentials: resolution.credentials };
}
