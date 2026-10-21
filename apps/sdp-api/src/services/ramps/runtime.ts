import { providerNotConfigured } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { checkRampCredentials, checkRampWebhookSecret } from "@sdp/payments/ramps/shared";
import type {
  RampCredentialsResolution,
  RampKeyFormat,
  RampRuntimeContext,
} from "@sdp/payments/ramps/types";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import type { Env } from "@/types/env";

/**
 * Each provider's own term for its public key: the one part of a managed key's
 * name that differs by provider.
 */
const PUBLIC_KEY_TERMS = {
  moonpay: "API_KEY",
  stripe: "PUBLISHABLE_KEY",
} as const satisfies Record<RampProviderId, string>;

const ROLE_TERMS = {
  secretKey: "SECRET_KEY",
  webhookSecret: "WEBHOOK_SECRET",
} as const satisfies Record<Exclude<ManagedRampKeyRole, "publicKey">, string>;

/** A key of a provider's account, as its key formats declare it. */
export type ManagedRampKeyRole = keyof RampKeyFormat;

type ManagedRampKeyNameOf<Provider extends RampProviderId> =
  `${Uppercase<Provider>}_${Uppercase<SdpEnvironment>}_${(typeof PUBLIC_KEY_TERMS)[Provider] | (typeof ROLE_TERMS)[keyof typeof ROLE_TERMS]}`;

/** Every env var a managed ramp key can live under. */
export type ManagedRampKeyName = {
  [Provider in RampProviderId]: ManagedRampKeyNameOf<Provider>;
}[RampProviderId];

/**
 * The part of the environment SDP's managed ramp keys are read from. `Pick`
 * fails typecheck when `env.d.ts` doesn't declare a derived name.
 */
export type ManagedRampKeysEnv = Readonly<Partial<Pick<Env, ManagedRampKeyName>>>;

/**
 * The env var SDP keeps `provider`'s `role` key for `mode` under:
 * `<PROVIDER>_<MODE>_<ROLE>`, with the public key under the provider's own term.
 *
 * @param provider - The ramp provider.
 * @param mode - The mode the key serves.
 * @param role - The key.
 * @returns The env var name.
 */
export function managedRampKeyName(
  provider: RampProviderId,
  mode: SdpEnvironment,
  role: ManagedRampKeyRole
): ManagedRampKeyName {
  const term = role === "publicKey" ? PUBLIC_KEY_TERMS[provider] : ROLE_TERMS[role];
  // SAFETY: provider and mode are the lowercase literals the template type upper-cases, and
  // term is that provider's public-key term or a role term, so the result is a ManagedRampKeyName.
  return `${provider.toUpperCase()}_${mode.toUpperCase()}_${term}` as ManagedRampKeyName;
}

/** The key roles `provider` declares, in the order a refusal names them. */
function managedRampKeyRoles(provider: RampProviderId): readonly ManagedRampKeyRole[] {
  return RAMP_PROVIDER_CLIENTS[provider].keyFormats.sandbox.webhookSecret === undefined
    ? ["publicKey", "secretKey"]
    : ["publicKey", "secretKey", "webhookSecret"];
}

/** Every managed key name, for every provider and both modes. */
export const MANAGED_RAMP_KEY_NAMES: readonly ManagedRampKeyName[] = RAMP_PROVIDERS.flatMap(
  (provider) =>
    SDP_ENVIRONMENTS.flatMap((mode) =>
      managedRampKeyRoles(provider).map((role) => managedRampKeyName(provider, mode, role))
    )
);

function readManagedRampKey(
  env: ManagedRampKeysEnv,
  provider: RampProviderId,
  mode: SdpEnvironment,
  role: ManagedRampKeyRole
): string | undefined {
  const value = env[managedRampKeyName(provider, mode, role)]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function notConfiguredReason(
  provider: RampProviderId,
  mode: SdpEnvironment,
  roles: readonly ManagedRampKeyRole[]
): string {
  const names = roles.map((role) => managedRampKeyName(provider, mode, role));
  return `${RAMP_PROVIDER_CLIENTS[provider].label} ${mode} is not configured. Set ${names.join(" and ")}.`;
}

/**
 * SDP's managed keys for calls to `provider` in `mode`, or why they can't
 * serve it. Live keys exist only where Doppler holds them (`prd`), so a
 * production project elsewhere fails closed. The provider's formats then check
 * the keys fit the mode, so a key from the other mode never makes a request.
 * Availability, every provider call and rail discovery read this, so they
 * never disagree.
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
  const publicKey = readManagedRampKey(env, provider, mode, "publicKey");
  const secretKey = readManagedRampKey(env, provider, mode, "secretKey");
  if (publicKey === undefined || secretKey === undefined) {
    return { ok: false, reason: notConfiguredReason(provider, mode, ["publicKey", "secretKey"]) };
  }
  const credentials = { publicKey, secretKey };
  const refusal = checkRampCredentials(RAMP_PROVIDER_CLIENTS[provider], credentials, mode);
  return refusal === null ? { ok: true, credentials } : { ok: false, reason: refusal };
}

/** The secret that verifies a provider's webhooks in one mode, or why none can. */
export type ManagedRampWebhookSecretResolution =
  | { ok: true; secret: string }
  | { ok: false; reason: string };

/**
 * SDP's managed secret for `provider`'s `mode` webhooks, or why it can't
 * verify them.
 *
 * @param env - Where the managed keys are mounted.
 * @param provider - The ramp provider.
 * @param mode - The mode the webhook route serves.
 * @returns The secret, or the refusal.
 */
export function resolveManagedRampWebhookSecret(
  env: ManagedRampKeysEnv,
  provider: RampProviderId,
  mode: SdpEnvironment
): ManagedRampWebhookSecretResolution {
  const client = RAMP_PROVIDER_CLIENTS[provider];
  if (client.keyFormats[mode].webhookSecret === undefined) {
    return { ok: false, reason: `${client.label} takes no webhooks.` };
  }
  const secret = readManagedRampKey(env, provider, mode, "webhookSecret");
  if (secret === undefined) {
    return { ok: false, reason: notConfiguredReason(provider, mode, ["webhookSecret"]) };
  }
  const refusal = checkRampWebhookSecret(client, secret, mode);
  return refusal === null ? { ok: true, secret } : { ok: false, reason: refusal };
}

/**
 * Whether every key `provider` declares can serve `mode`: what availability
 * reports, so a provider never shows as configured while its webhooks can't
 * be verified.
 *
 * @param env - Where the managed keys are mounted.
 * @param provider - The ramp provider.
 * @param mode - The project's mode.
 * @returns Whether the managed keys serve the mode.
 */
export function isManagedRampConfigured(
  env: ManagedRampKeysEnv,
  provider: RampProviderId,
  mode: SdpEnvironment
): boolean {
  if (!resolveManagedRampCredentials(env, provider, mode).ok) {
    return false;
  }
  return (
    RAMP_PROVIDER_CLIENTS[provider].keyFormats[mode].webhookSecret === undefined ||
    resolveManagedRampWebhookSecret(env, provider, mode).ok
  );
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

/**
 * The secret a webhook processor verifies `provider`'s `mode` deliveries with.
 *
 * @param env - Where the managed keys are mounted.
 * @param provider - The ramp provider.
 * @param mode - The mode the webhook route serves.
 * @returns The secret.
 * @throws SdpPaymentsError PROVIDER_NOT_CONFIGURED when no valid secret serves `mode`.
 */
export function managedRampWebhookSecret(
  env: ManagedRampKeysEnv,
  provider: RampProviderId,
  mode: SdpEnvironment
): string {
  const resolution = resolveManagedRampWebhookSecret(env, provider, mode);
  if (!resolution.ok) {
    throw providerNotConfigured(resolution.reason);
  }
  return resolution.secret;
}
