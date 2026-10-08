import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  CUSTODY_MODES,
  CUSTODY_PROVIDERS,
  type CustodyMode,
  type CustodyProvider,
  type CustodySetupRefusalReason,
  EARN_PROVIDERS,
  type EarnProviderId,
  isCustodyModeAllowedInEnvironment,
  isEarnProviderSurfaced,
  isRampProviderSurfaced,
  normalizeOrganizationTier,
  ORGANIZATION_PROVIDER_FAMILIES,
  type OrganizationProviderAvailabilityResponse,
  type OrganizationProviderFamily,
  type OrganizationProviderOverrides,
  type OrganizationSettings,
  type OrganizationTier,
  type ProjectProviderAvailability,
  type ProjectProviderAvailabilityEntry,
  type ProjectProviderRefusalReason,
  type ProviderAvailabilityEntry,
  RAMP_PROVIDERS,
  type RampProviderId,
  resolveOrganizationProviderEntitlements,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpEnvironment,
  type SdpRampProviderStages,
} from "@sdp/types";
import type { Context } from "hono";
import { type DatabaseExecutor, getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, forbidden } from "@/lib/errors";
import {
  isCustodyProviderAvailable,
  isEarnEnabled,
  isModuleAvailable,
  isRampProviderAvailable,
} from "@/lib/feature-flags";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";

type OrganizationProviderRow = {
  tier: string;
  settings: string | null;
};

type ClerkOrganizationWithMetadata = {
  id: string;
  private_metadata?: unknown;
};

type ProviderAvailabilityDefinition = {
  label: string;
  isConfigured: (env: Env, testMode?: boolean) => boolean;
  /**
   * Env keys this definition actually consults, when it consults any.
   *
   * Declared so the drift guard can assert over the keys that are really read
   * rather than re-deriving them from a naming convention — which would demand
   * a credential for a provider that has none. Absent means the provider needs
   * no configuration (a public API).
   */
  credentialEnvKeys?: readonly (keyof Env)[];
};

type ProviderAvailabilityDefinitions = {
  custody: Record<CustodyProvider, ProviderAvailabilityDefinition>;
  compliance: Record<ComplianceProviderId, ProviderAvailabilityDefinition>;
  ramps: Record<RampProviderId, ProviderAvailabilityDefinition>;
  earn: Record<EarnProviderId, ProviderAvailabilityDefinition>;
};

type ProviderIdByFamily = {
  custody: CustodyProvider;
  compliance: ComplianceProviderId;
  ramps: RampProviderId;
  earn: EarnProviderId;
};

function hasEnv(env: Env, key: keyof Env): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasAllEnv(env: Env, keys: readonly (keyof Env)[]): boolean {
  return keys.every((key) => hasEnv(env, key));
}

/**
 * Earn providers SDP reaches with a credential, which is most but not all of
 * them — see `publicApiDefinition` below. Excluding the keyless ones here is
 * what stops `keyPairCredentialDefinition` from requiring Kamino or Veda API
 * keys on `Env`: the template literal below must resolve to a `keyof Env` for
 * every member of this union, so widening it silently demands a credential.
 */
type KeyPairedEarnProviderId = Exclude<
  EarnProviderId,
  "kamino" | "veda" | "jupiter_lend" | "ondo" | "hastra"
>;

/**
 * Credentialed earn providers share one shape: `<PREFIX>_API_KEY` for
 * production and `<PREFIX>_SANDBOX_API_KEY` for sandbox. Binding the derived
 * keys to `keyof Env` makes a provider whose keys are missing from env.d.ts a
 * compile error; provider-availability.drift.test.ts guards the projections
 * (turbo.json globalEnv, scripts/secret-keys.mjs) the type system cannot see.
 */
function keyPairCredentialDefinition(
  label: string,
  envPrefix: Uppercase<KeyPairedEarnProviderId>
): ProviderAvailabilityDefinition {
  const prodKey: keyof Env = `${envPrefix}_API_KEY`;
  const sandboxKey: keyof Env = `${envPrefix}_SANDBOX_API_KEY`;
  return {
    label,
    credentialEnvKeys: [prodKey, sandboxKey],
    isConfigured: (env, testMode) => {
      const prod = hasEnv(env, prodKey);
      const sandbox = hasEnv(env, sandboxKey);
      if (testMode === true) return sandbox;
      if (testMode === false) return prod;
      return prod || sandbox;
    },
  };
}

/**
 * A provider reached over a PUBLIC API, with nothing to configure.
 *
 * Kamino's public API and Veda's on-chain reads take no credential, so "is it
 * configured" has no meaningful negative answer. They report configured
 * everywhere; cluster-specific deployment registries separately decide whether
 * a real instrument can be catalogued or executed.
 *
 * Deliberately NOT given placeholder provider keys. scripts/secret-keys.mjs is
 * "every env key the SDP API reads" and
 * projects into the local and Docker env files; a declared secret nothing reads
 * is a standing question for whoever next provisions this service.
 *
 * Note what this does NOT relax: entitlement. An org still needs the
 * `providerOverrides.earn.<provider>` override for any money-in path.
 */
function publicApiDefinition(label: string): ProviderAvailabilityDefinition {
  return { label, isConfigured: () => true };
}

const PROVIDER_AVAILABILITY_DEFINITIONS = {
  custody: {
    local: {
      label: "Local",
      isConfigured: (env) => isSelfHostedDeployment(env) && hasEnv(env, "CUSTODY_PRIVATE_KEY"),
    },
    fireblocks: {
      label: "Fireblocks",
      isConfigured: (env) => hasAllEnv(env, ["FIREBLOCKS_API_KEY", "FIREBLOCKS_API_SECRET"]),
    },
    privy: {
      label: "Privy",
      isConfigured: (env) => hasAllEnv(env, ["PRIVY_APP_ID", "PRIVY_APP_SECRET"]),
    },
    coinbase_cdp: {
      label: "Coinbase CDP",
      isConfigured: (env) =>
        hasAllEnv(env, [
          "COINBASE_CDP_API_KEY_ID",
          "COINBASE_CDP_API_KEY_SECRET",
          "COINBASE_CDP_WALLET_SECRET",
        ]),
    },
    para: {
      label: "Para",
      isConfigured: (env) => hasEnv(env, "PARA_API_KEY"),
    },
    turnkey: {
      label: "Turnkey",
      isConfigured: (env) =>
        hasAllEnv(env, [
          "TURNKEY_API_PUBLIC_KEY",
          "TURNKEY_API_PRIVATE_KEY",
          "TURNKEY_ORGANIZATION_ID",
        ]),
    },
    dfns: {
      label: "DFNS",
      isConfigured: (env) =>
        hasAllEnv(env, ["DFNS_AUTH_TOKEN", "DFNS_CREDENTIAL_ID", "DFNS_PRIVATE_KEY"]),
    },
    ibm_haven: {
      label: "IBM Digital Asset Haven",
      isConfigured: (env) =>
        hasAllEnv(env, [
          "IBM_HAVEN_AUTH_TOKEN",
          "IBM_HAVEN_CREDENTIAL_ID",
          "IBM_HAVEN_PRIVATE_KEY",
        ]),
    },
    anchorage: {
      label: "Anchorage",
      isConfigured: (env) => hasEnv(env, "ANCHORAGE_API_KEY"),
    },
    utila: {
      label: "Utila",
      isConfigured: (env) =>
        hasAllEnv(env, [
          "UTILA_SERVICE_ACCOUNT_EMAIL",
          "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
          "UTILA_VAULT_ID",
        ]),
    },
  },
  compliance: {
    range: {
      label: "Range",
      isConfigured: (env) => hasEnv(env, "RANGE_API_KEY"),
    },
    elliptic: {
      label: "Elliptic",
      isConfigured: (env) =>
        hasEnv(env, "ELLIPTIC_API_TOKEN") ||
        hasAllEnv(env, ["ELLIPTIC_API_KEY", "ELLIPTIC_API_SECRET"]),
    },
    trm: {
      label: "TRM",
      isConfigured: (env) => hasEnv(env, "TRM_API_KEY"),
    },
    chainalysis: {
      label: "Chainalysis",
      isConfigured: (env) => hasEnv(env, "CHAINALYSIS_API_KEY"),
    },
  },
  ramps: {
    moonpay: {
      label: "MoonPay",
      isConfigured: (env, testMode) => {
        const prod = hasAllEnv(env, ["MOONPAY_API_KEY", "MOONPAY_SECRET_KEY"]);
        const sandbox = hasAllEnv(env, ["MOONPAY_SANDBOX_API_KEY", "MOONPAY_SANDBOX_SECRET_KEY"]);
        if (testMode === true) return sandbox;
        if (testMode === false) return prod;
        return prod || sandbox;
      },
    },
    lightspark: {
      label: "Lightspark",
      isConfigured: (env, testMode) => {
        const prod = hasAllEnv(env, ["LIGHTSPARK_GRID_CLIENT_ID", "LIGHTSPARK_GRID_CLIENT_SECRET"]);
        const sandbox = hasAllEnv(env, [
          "LIGHTSPARK_GRID_SANDBOX_CLIENT_ID",
          "LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET",
        ]);
        if (testMode === true) return sandbox;
        if (testMode === false) return prod;
        return prod || sandbox;
      },
    },
    bvnk: {
      label: "BVNK",
      isConfigured: (env, testMode) => {
        const prod = hasAllEnv(env, [
          "BVNK_WALLET_ID",
          "BVNK_HAWK_AUTH_ID",
          "BVNK_HAWK_SECRET_KEY",
        ]);
        const sandbox = hasAllEnv(env, [
          "BVNK_SANDBOX_WALLET_ID",
          "BVNK_SANDBOX_HAWK_AUTH_ID",
          "BVNK_SANDBOX_HAWK_SECRET_KEY",
        ]);
        if (testMode === true) return sandbox;
        if (testMode === false) return prod;
        return prod || sandbox;
      },
    },
    moneygram: {
      label: "MoneyGram",
      isConfigured: (env, testMode) => {
        const sandbox = hasAllEnv(env, [
          "MONEYGRAM_SANDBOX_PUBLIC_KEY",
          "MONEYGRAM_SANDBOX_SECRET_KEY",
        ]);
        if (testMode === false) return false;
        return sandbox;
      },
    },
    coinbase: {
      label: "Coinbase Onramp",
      // Onramp uses the account-wide CDP Secret API Key (same key across environments).
      isConfigured: (env) =>
        hasAllEnv(env, ["COINBASE_CDP_API_KEY_ID", "COINBASE_CDP_API_KEY_SECRET"]),
    },
    mural: {
      label: "Mural Pay",
      isConfigured: (env, testMode) => {
        const prod = hasAllEnv(env, ["MURAL_PAY_API_KEY", "MURAL_PAY_TRANSFER_API_KEY"]);
        const sandbox = hasAllEnv(env, [
          "MURAL_PAY_SANDBOX_API_KEY",
          "MURAL_PAY_SANDBOX_TRANSFER_API_KEY",
        ]);
        if (testMode === true) return sandbox;
        if (testMode === false) return prod;
        return prod || sandbox;
      },
    },
    stripe: {
      label: "Stripe",
      isConfigured: (env) =>
        hasAllEnv(env, ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"]),
    },
  },
  earn: {
    // Keyless like Kamino, though for a cluster reason rather than Kamino's
    // account one: Veda's vaults are read and written entirely on-chain through
    // `@sdp/veda`, so there is no provider API to authenticate against, and no
    // credential to declare here. Veda's sandbox/production split is devnet vs
    // mainnet, with the vaults deployed at the same addresses on both clusters,
    // so this gate always passes and a vault absent from the selected cluster
    // fails in the SDK call rather than at this gate.
    veda: publicApiDefinition("Veda"),
    upshift: keyPairCredentialDefinition("Upshift", "UPSHIFT"),
    perena: keyPairCredentialDefinition("Perena", "PERENA"),
    kamino: publicApiDefinition("Kamino"),
    jupiter_lend: publicApiDefinition("Jupiter Lend"),
    // No Ondo credential: the catalogue reads the chain and the execution half
    // swaps on the open market. What that execution DOES need is the platform
    // Jupiter swap key (shared with swap-funded deposits), so readiness gates
    // on it here rather than reporting `configured: true` and failing at build
    // time — an entitled organization must not be offered a deposit action the
    // provider cannot honour. One key for both modes: Jupiter has no sandbox
    // tenant, and USDY exists on mainnet only anyway.
    ondo: {
      label: "Ondo",
      credentialEnvKeys: ["JUPITER_SWAP_API_KEY"],
      isConfigured: (env) => hasEnv(env, "JUPITER_SWAP_API_KEY"),
    },
    // Hastra's PRIME mint/stake legs and operator-redemption request are
    // permissionless on-chain, so the provider remains configured without a
    // Jupiter credential. Its optional market exit is admitted separately by
    // EARN_HASTRA_DEX_EXIT_ENABLED plus JUPITER_SWAP_API_KEY; neither may gate
    // deposits or the default par-redemption escape hatch.
    hastra: publicApiDefinition("Hastra / Figure"),
    // One packed JSON credential per environment (OAuth2 password-grant quad —
    // clientId/clientSecret/username/password); format documented on
    // `EarnRuntimeEnvironment` in @sdp/earn. Configured means "the key is set",
    // not "the JSON parses" — the provider client validates the shape and
    // fails closed with PROVIDER_NOT_CONFIGURED on malformed content.
    wisdomtree: keyPairCredentialDefinition("WisdomTree", "WISDOMTREE"),
  },
} as const satisfies ProviderAvailabilityDefinitions;

/**
 * The env keys each earn availability definition actually reads, per provider
 * — the drift guard's source of truth (provider-availability.drift.test.ts).
 *
 * Keyed by provider so the guard can tell "declares no credential" (a keyless
 * provider, named on purpose) from "declares one that does not follow the
 * `<ID>_API_KEY` convention" (Ondo, which gates on the platform Jupiter key).
 * A prefix match would misread the second as the first.
 */
export const EARN_CREDENTIAL_ENV_KEYS_BY_PROVIDER: Readonly<
  Record<EarnProviderId, readonly string[]>
> = Object.fromEntries(
  Object.entries(PROVIDER_AVAILABILITY_DEFINITIONS.earn).map(([provider, definition]) => [
    provider,
    (definition as ProviderAvailabilityDefinition).credentialEnvKeys ?? [],
  ])
) as Record<EarnProviderId, readonly string[]>;

/**
 * Every env key an earn availability definition actually reads, flattened —
 * checked against turbo.json globalEnv and scripts/secret-keys.mjs.
 *
 * Derived from the definitions rather than from `EARN_PROVIDERS` by naming
 * convention, so it stays correct for a provider that needs no credential and
 * for any future one whose credential is not a key pair.
 */
export const EARN_CREDENTIAL_ENV_KEYS: readonly string[] = [
  ...new Set(Object.values(EARN_CREDENTIAL_ENV_KEYS_BY_PROVIDER).flat()),
];

/**
 * Reuse the deployment configuration checks without exposing credential values.
 * Setup/status surfaces use this for side-effect-free checks; provider runtimes
 * continue to enforce availability through getProviderAvailability.
 */
export function isProviderConfigured<Family extends OrganizationProviderFamily>(
  env: Env,
  family: Family,
  providerId: ProviderIdByFamily[Family],
  testMode?: boolean
): boolean {
  const definitions = PROVIDER_AVAILABILITY_DEFINITIONS[family] as Record<
    string,
    ProviderAvailabilityDefinition
  >;
  return definitions[providerId]?.isConfigured(env, testMode) ?? false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseOrganizationSettings(raw: string | null): OrganizationSettings | null {
  if (!raw) {
    return null;
  }

  try {
    return parsePostgresJson<OrganizationSettings>(raw);
  } catch {
    throw new AppError("INTERNAL_ERROR", "Organization settings are invalid JSON");
  }
}

function toStoredOrganizationSettings(settings: OrganizationSettings | null): string | null {
  if (!settings) {
    return null;
  }

  return JSON.stringify(settings);
}

function hasOwnEntries(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function parseBooleanOverrides<T extends string>(
  source: unknown,
  allowedValues: readonly T[]
): Partial<Record<T, boolean>> | undefined {
  const record = asRecord(source);
  if (!record) {
    return undefined;
  }

  const next: Partial<Record<T, boolean>> = {};
  const allowed = new Set<string>(allowedValues);

  for (const [key, value] of Object.entries(record)) {
    if (!allowed.has(key) || typeof value !== "boolean") {
      continue;
    }

    next[key as T] = value;
  }

  return hasOwnEntries(next as Record<string, unknown>) ? next : undefined;
}

export function parseProviderOverridesFromClerkMetadata(
  source: unknown
): OrganizationProviderOverrides | undefined {
  const record = asRecord(source);
  if (!record) {
    return undefined;
  }

  const next: OrganizationProviderOverrides = {};

  const custody = parseBooleanOverrides(record.custody, CUSTODY_PROVIDERS);
  if (custody) {
    next.custody = custody;
  }

  const compliance = parseBooleanOverrides(record.compliance, COMPLIANCE_PROVIDERS);
  if (compliance) {
    next.compliance = compliance;
  }

  const ramps = parseBooleanOverrides(record.ramps, RAMP_PROVIDERS);
  if (ramps) {
    next.ramps = ramps;
  }

  const earn = parseBooleanOverrides(record.earn, EARN_PROVIDERS);
  if (earn) {
    next.earn = earn;
  }

  return hasOwnEntries(next as Record<string, unknown>) ? next : undefined;
}

export function parseClerkOrganizationTierMetadata(organization: ClerkOrganizationWithMetadata): {
  tier: OrganizationTier;
  providerOverrides?: OrganizationProviderOverrides;
  enableProductionProject: boolean;
} {
  const privateMetadata = asRecord(organization.private_metadata);
  const sdp = asRecord(privateMetadata?.sdp);

  return {
    tier: normalizeOrganizationTier(typeof sdp?.tier === "string" ? sdp.tier : undefined),
    providerOverrides: parseProviderOverridesFromClerkMetadata(sdp?.providerOverrides),
    enableProductionProject: sdp?.enableProductionProject === true,
  };
}

export async function getOrganizationTierState(
  db: DatabaseExecutor,
  organizationId: string
): Promise<{ tier: OrganizationTier; settings: OrganizationSettings | null }> {
  const row = await db
    .prepare(
      `SELECT tier, settings
       FROM organizations
       WHERE id = ?`
    )
    .bind(organizationId)
    .first<OrganizationProviderRow>();

  if (!row) {
    throw new AppError("NOT_FOUND", "Organization not found");
  }

  return {
    tier: normalizeOrganizationTier(row.tier),
    settings: parseOrganizationSettings(row.settings),
  };
}

function buildConfiguredProviderEntries<T extends string>(
  definitions: Record<T, ProviderAvailabilityDefinition>,
  env: Env
): Record<T, boolean> {
  return Object.fromEntries(
    Object.entries(definitions).map(([providerId, definition]) => [
      providerId,
      (definition as ProviderAvailabilityDefinition).isConfigured(env),
    ])
  ) as Record<T, boolean>;
}

function getConfiguredProviders(env: Env) {
  return {
    custody: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.custody, env),
    compliance: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.compliance, env),
    ramps: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.ramps, env),
    earn: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.earn, env),
  };
}

/**
 * `inReleaseChannel` caps `enabled`: a provider the deployment's release channel
 * leaves out is never reported as usable, whatever the organization is entitled to.
 */
function buildAvailabilityEntries<T extends string>(
  entitled: Record<T, boolean>,
  configured: Record<T, boolean>,
  inReleaseChannel: (provider: T) => boolean
): Record<T, ProviderAvailabilityEntry> {
  return Object.fromEntries(
    Object.keys(entitled).map((key) => {
      const isEntitled = entitled[key as T] ?? false;
      const isConfigured = configured[key as T] ?? false;

      return [
        key,
        {
          entitled: isEntitled,
          configured: isConfigured,
          enabled: isEntitled && isConfigured && inReleaseChannel(key as T),
        },
      ];
    })
  ) as Record<T, ProviderAvailabilityEntry>;
}

function getProviderLabel(family: OrganizationProviderFamily, providerId: string): string {
  const familyDefinitions = PROVIDER_AVAILABILITY_DEFINITIONS[family] as Record<
    string,
    ProviderAvailabilityDefinition
  >;
  return familyDefinitions[providerId]?.label ?? providerId;
}

/** The ramp provider stages to evaluate: the request's `rampProviderStages`, else `SDP_RAMP_PROVIDER_STAGES`. */
export interface ProviderAvailabilityOptions {
  rampProviderStages: SdpRampProviderStages;
}

/**
 * For callers that never read a ramp entry (custody, Earn, compliance checks).
 * Ramp provider stages only change the ramps entries, so the manifest is exact here.
 */
const MANIFEST_RAMP_STAGES: ProviderAvailabilityOptions = {
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
};

export async function getProviderAvailability(
  env: Env,
  db: DatabaseExecutor,
  organizationId: string,
  options: ProviderAvailabilityOptions
): Promise<OrganizationProviderAvailabilityResponse> {
  const organization = await getOrganizationTierState(db, organizationId);
  const resolved = resolveOrganizationProviderEntitlements({
    tier: organization.tier,
    providerOverrides: organization.settings?.providerOverrides,
  });
  const configured = getConfiguredProviders(env);

  return {
    tier: resolved.tier,
    providers: {
      custody: buildAvailabilityEntries(
        resolved.providers.custody,
        configured.custody,
        (provider) => CUSTODY_MODES.some((mode) => isCustodyProviderAvailable(env, provider, mode))
      ),
      compliance: buildAvailabilityEntries(
        resolved.providers.compliance,
        configured.compliance,
        () => isModuleAvailable(env, "compliance", options.rampProviderStages)
      ),
      ramps: buildAvailabilityEntries(resolved.providers.ramps, configured.ramps, (provider) =>
        isRampProviderAvailable(env, provider, options.rampProviderStages)
      ),
      earn: buildAvailabilityEntries(resolved.providers.earn, configured.earn, () =>
        isEarnEnabled(env)
      ),
    },
  };
}

export function isCustodyProviderEntitled(
  availability: OrganizationProviderAvailabilityResponse,
  provider: CustodyProvider
): boolean {
  return availability.providers.custody[provider]?.entitled === true;
}

/**
 * Runtime admission for persisted custody owners depends on organization
 * entitlement, not on legacy environment credentials. Stored Connection
 * credentials remain usable when the matching runtime-env credential is absent.
 */
export async function assertCustodyProviderEntitled(
  env: Env,
  db: DatabaseExecutor,
  organizationId: string,
  provider: CustodyProvider
): Promise<void> {
  const availability = await getProviderAvailability(env, db, organizationId, MANIFEST_RAMP_STAGES);
  const entry = availability.providers.custody[provider];
  if (!isCustodyProviderEntitled(availability, provider)) {
    logEvent("warn", {
      event: "sdp_api_custody_entitlement_denied",
      organization_id: organizationId,
      provider,
      reason: "provider_not_entitled",
    });
    throw new AppError(
      "FORBIDDEN",
      getAvailabilityMessage(
        availability.tier,
        "custody",
        provider,
        entry ?? { entitled: false, configured: false, enabled: false }
      ),
      { reason: "provider_not_entitled" }
    );
  }
}

/**
 * A 403 from the custody setup rule. Its `details.reason` names the failed
 * check, typed so a refusal's reason is read from the error itself.
 */
export class CustodySetupRefusedError extends AppError {
  declare readonly details: { reason: CustodySetupRefusalReason };

  /**
   * Builds the 403 for one failed custody setup check.
   *
   * @param message - What the failed check found.
   * @param reason - The failed check.
   */
  constructor(message: string, reason: CustodySetupRefusalReason) {
    super("FORBIDDEN", message, { reason });
  }
}

/**
 * The refusal for a (custody provider, mode) pair the deployment's release channel leaves out.
 *
 * @param provider - The custody provider.
 * @param mode - The custody mode the provider is used in.
 * @returns A 403 naming the pair, the same shape as the module and ramp provider gates.
 */
export function custodyProviderNotInReleaseChannel(
  provider: CustodyProvider,
  mode: CustodyMode
): CustodySetupRefusedError {
  return new CustodySetupRefusedError(
    `The ${provider} custody provider is not available in this release channel for ${mode} custody.`,
    "custody_provider_not_in_release_channel"
  );
}

/**
 * Refuses a (custody provider, mode) pair the deployment's release channel leaves out.
 *
 * @param env - Process environment naming the release channel.
 * @param provider - The custody provider.
 * @param mode - The custody mode the provider is used in.
 */
export function assertCustodyProviderAvailable(
  env: Pick<Env, "SDP_RELEASE_CHANNEL">,
  provider: CustodyProvider,
  mode: CustodyMode
): void {
  if (!isCustodyProviderAvailable(env, provider, mode)) {
    throw custodyProviderNotInReleaseChannel(provider, mode);
  }
}

/** The project a provider availability decision is made for. */
export interface ProjectProviderScope {
  organizationId: string;
  projectId: string;
}

/** A (custody provider, mode) pair a project is setting up. */
export interface CustodySetupRequest extends ProjectProviderScope {
  provider: CustodyProvider;
  mode: CustodyMode;
}

/**
 * A provider a project is about to use; custody names the mode it is used in.
 * Earn has two arms: the plain one opens a NEW position (create, deposit and
 * the availability read), and `program: "existing"` points a program that
 * already exists at a provider (re-target). The existing-program arm skips
 * only surfacing, so un-surfacing can never trap a position (ADR 0002); every
 * other check still applies because it points money at the provider.
 */
export type ProjectProviderRequest =
  | { family: "custody"; provider: CustodyProvider; mode: CustodyMode }
  | { family: "compliance"; provider: ComplianceProviderId }
  | { family: "ramps"; provider: RampProviderId }
  | { family: "earn"; provider: EarnProviderId }
  | { family: "earn"; provider: EarnProviderId; program: "existing" };

/**
 * The custody setup rule's refusal of one pair: the 403 and the request and
 * project environment it was decided for, so whoever refuses the request can
 * log it.
 */
export interface CustodySetupRefusal {
  admitted: false;
  request: CustodySetupRequest;
  environment: SdpEnvironment;
  error: CustodySetupRefusedError;
}

/** The custody setup rule's verdict on one (provider, mode) pair for a project. */
export type CustodySetupAdmission = { admitted: true } | CustodySetupRefusal;

/**
 * The project provider rule's refusal of one provider: its error and the
 * project, environment and request it was decided for, so whoever refuses the
 * request can log it.
 */
export interface ProjectProviderRefusal {
  admitted: false;
  scope: ProjectProviderScope;
  environment: SdpEnvironment;
  request: ProjectProviderRequest;
  reason: ProjectProviderRefusalReason;
  error: AppError;
}

/** The project provider rule's verdict on one provider for a project. */
export type ProjectProviderDecision = { admitted: true } | ProjectProviderRefusal;

interface ProjectProviderFacts {
  scope: ProjectProviderScope;
  environment: SdpEnvironment;
  availability: OrganizationProviderAvailabilityResponse;
}

const CUSTODY_MODE_LABELS = {
  managed: "Managed",
  byok: "BYOK",
} as const satisfies Record<CustodyMode, string>;

/**
 * The project's environment, read from its active `projects` row: never from
 * the API key, its cache or request state.
 *
 * @param db - Database client for the project row.
 * @param project - The project being decided for.
 * @param project.organizationId - The organization that owns the project.
 * @param project.projectId - The project whose environment is read.
 * @returns The project's environment.
 * @throws 404 when the project is not an active project of the organization.
 */
async function loadActiveProjectEnvironment(
  db: DatabaseExecutor,
  project: ProjectProviderScope
): Promise<SdpEnvironment> {
  const row = await db
    .prepare(
      "SELECT environment FROM projects WHERE id = ? AND organization_id = ? AND status = 'active'"
    )
    .bind(project.projectId, project.organizationId)
    .first<{ environment: SdpEnvironment }>();
  if (!row) {
    throw new AppError("NOT_FOUND", "Project not found");
  }
  return row.environment;
}

/**
 * The refusal for a custody mode the project's environment does not allow.
 *
 * @param provider - The custody provider.
 * @param mode - The custody mode the provider is used in.
 * @param environment - The project's environment.
 * @returns A 403 with `details.reason` `custody_mode_not_allowed`.
 */
function custodyModeNotAllowed(
  provider: CustodyProvider,
  mode: CustodyMode,
  environment: SdpEnvironment
): CustodySetupRefusedError {
  return new CustodySetupRefusedError(
    `${getProviderLabel("custody", provider)} ${CUSTODY_MODE_LABELS[mode]} custody is not allowed in a ${environment} project.`,
    "custody_mode_not_allowed"
  );
}

/**
 * Reads what the project provider rule decides from: the project's environment
 * from its active `projects` row (never from the API key, its cache or request
 * state) and the organization's provider access.
 *
 * @param env - Process environment the provider access is evaluated against.
 * @param db - Database client for the project and organization rows.
 * @param scope - The project being decided for.
 * @param scope.organizationId - The organization that owns the project.
 * @param scope.projectId - The project the decision is for.
 * @returns The project, its environment and its organization's provider access.
 * @throws 404 when the project is not an active project of the organization.
 */
async function loadProjectProviderFacts(
  env: Env,
  db: DatabaseExecutor,
  scope: ProjectProviderScope
): Promise<ProjectProviderFacts> {
  return {
    scope: { organizationId: scope.organizationId, projectId: scope.projectId },
    environment: await loadActiveProjectEnvironment(db, scope),
    availability: await getProviderAvailability(
      env,
      db,
      scope.organizationId,
      MANIFEST_RAMP_STAGES
    ),
  };
}

/**
 * The custody setup rule (ADR 0006). A (provider, mode) pair is admitted for a
 * project when, in order: the deployment's release channel offers it; the
 * project's environment allows the mode (Production = BYOK only); and the
 * organization is entitled to the provider. The channel alone decides which
 * pairs are offered, the same for Sandbox and Production. Managed custody also needs the deployment to
 * hold the provider's credentials, which the project provider rule checks
 * after this one as it does for every family; BYOK needs self-service
 * credential setup, which the channel check already implies (the catalog types
 * every `BYOK_CUSTODY_PROVIDERS` entry as self-service).
 *
 * @param env - Process environment naming the release channel.
 * @param facts - The project's environment and its organization's provider access.
 * @param request - The pair being set up and the project it is for.
 * @param request.organizationId - The organization that owns the project.
 * @param request.projectId - The project setting up custody.
 * @param request.provider - The custody provider being set up.
 * @param request.mode - The custody mode being set up.
 * @returns Admitted, or the refusal carrying the first failed check's 403.
 */
function decideCustodySetup(
  env: Env,
  facts: ProjectProviderFacts,
  request: CustodySetupRequest
): CustodySetupAdmission {
  const { provider, mode } = request;
  const refuse = (error: CustodySetupRefusedError): CustodySetupRefusal => ({
    admitted: false,
    request,
    environment: facts.environment,
    error,
  });
  if (!isCustodyProviderAvailable(env, provider, mode)) {
    return refuse(custodyProviderNotInReleaseChannel(provider, mode));
  }
  if (!isCustodyModeAllowedInEnvironment(facts.environment, mode)) {
    return refuse(custodyModeNotAllowed(provider, mode, facts.environment));
  }
  const entry = facts.availability.providers.custody[provider];
  if (!entry.entitled) {
    return refuse(
      new CustodySetupRefusedError(
        getAvailabilityMessage(facts.availability.tier, "custody", provider, entry),
        "provider_not_entitled"
      )
    );
  }
  return { admitted: true };
}

/**
 * Builds the project provider rule's refusal of `request` for the facts' project.
 *
 * @param facts - The project, its environment and its organization's provider access.
 * @param request - The provider being refused.
 * @param reason - The failed check.
 * @param error - The error the refused request is answered with.
 * @returns The refusal.
 */
function projectProviderRefusal(
  facts: ProjectProviderFacts,
  request: ProjectProviderRequest,
  reason: ProjectProviderRefusalReason,
  error: AppError
): ProjectProviderRefusal {
  return {
    admitted: false,
    scope: facts.scope,
    environment: facts.environment,
    request,
    reason,
    error,
  };
}

/**
 * Whether the deployment holds `provider`'s credentials for the project's
 * environment: the same definitions the organization read's `configured` and
 * the runtime 503 credential checks use, in the project's mode (sandbox
 * project = sandbox credentials).
 *
 * @param env - Process environment holding the provider credentials.
 * @param facts - The project's environment and its organization's provider access.
 * @param family - The provider's family.
 * @param provider - The provider being used.
 * @returns Whether the deployment can operate the provider for this project.
 */
function isProviderConfiguredForProject<Family extends OrganizationProviderFamily>(
  env: Env,
  facts: ProjectProviderFacts,
  family: Family,
  provider: ProviderIdByFamily[Family]
): boolean {
  return isProviderConfigured(env, family, provider, facts.environment === "sandbox");
}

/**
 * The refusal for a provider the deployment holds no credentials for: a 503
 * `PROVIDER_NOT_CONFIGURED`, the status the runtime credential checks return,
 * since the caller can fix nothing about it.
 *
 * @param facts - The project, its environment and its organization's provider access.
 * @param request - The provider being used.
 * @returns The `provider_not_configured` refusal.
 */
function providerNotConfiguredForProject(
  facts: ProjectProviderFacts,
  request: ProjectProviderRequest
): ProjectProviderRefusal {
  return projectProviderRefusal(
    facts,
    request,
    "provider_not_configured",
    new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `${getProviderLabel(request.family, request.provider)} is not configured for ${facts.environment} projects in this deployment.`,
      { reason: "provider_not_configured" }
    )
  );
}

/**
 * The staged-provider rule for ramps, compliance and Earn. A provider is
 * admitted for a project when, in order: the deployment's release channel
 * includes it; SDP offers it (its surfacing, the same check the ramp and Earn
 * entry points run before entitlement); the organization is entitled to it;
 * and the deployment holds its credentials for the project's environment. The
 * channel alone decides which providers are offered, the same for Sandbox and
 * Production.
 *
 * @param facts - The project's environment and its organization's provider access.
 * @param request - The provider being used.
 * @param checks - The provider's verdicts from its family's stage table, surfacing, access entry and credentials.
 * @param checks.inReleaseChannel - Whether the deployment's release channel includes it.
 * @param checks.offered - Whether SDP surfaces it for the project's environment (always true for an existing Earn program).
 * @param checks.entry - The organization's access entry for the provider.
 * @param checks.configured - Whether the deployment holds its credentials for the project's environment.
 * @returns Admitted, or the first failed check with its 403 (503 when not configured).
 */
function decideStagedProvider(
  facts: ProjectProviderFacts,
  request: Exclude<ProjectProviderRequest, { family: "custody" }>,
  checks: {
    inReleaseChannel: boolean;
    offered: boolean;
    entry: ProviderAvailabilityEntry;
    configured: boolean;
  }
): ProjectProviderDecision {
  const label = getProviderLabel(request.family, request.provider);
  if (!checks.inReleaseChannel) {
    return projectProviderRefusal(
      facts,
      request,
      "provider_not_in_release_channel",
      forbidden(`${label} is not available in this release channel.`, {
        reason: "provider_not_in_release_channel",
      })
    );
  }
  if (!checks.offered) {
    return projectProviderRefusal(
      facts,
      request,
      "provider_not_offered",
      forbidden(`${label} is not currently offered.`, { reason: "provider_not_offered" })
    );
  }
  if (!checks.entry.entitled) {
    return projectProviderRefusal(
      facts,
      request,
      "provider_not_entitled",
      new AppError(
        "FORBIDDEN",
        getAvailabilityMessage(
          facts.availability.tier,
          request.family,
          request.provider,
          checks.entry
        ),
        { reason: "provider_not_entitled" }
      )
    );
  }
  if (!checks.configured) {
    return providerNotConfiguredForProject(facts, request);
  }
  return { admitted: true };
}

/**
 * The project provider rule, the one place it lives: every family's admission
 * for a project. The availability read and every entry-point gate decide from
 * this, so they cannot disagree. Custody follows the custody setup rule; ramps
 * are staged per provider; compliance and Earn by their module stage; ramps and
 * Earn must also be surfaced, as their entry points require, except an Earn
 * request for an existing program, which skips surfacing alone. Stages
 * come from the `@sdp/types` manifests, as the custody stages do, so tests
 * override them by mocking that module. Every family that runs on deployment
 * credentials (all but BYOK custody) also needs the deployment to hold them
 * for the project's environment. Evaluating is not refusing, so nothing is logged here: reads and replays
 * evaluate too.
 *
 * @param env - Process environment naming the release channel and holding the provider credentials.
 * @param facts - The project, its environment and its organization's provider access.
 * @param request - The provider being used (and, for custody, its mode).
 * @returns Admitted, or the refusal carrying the first failed check's 403 (503 when not configured).
 */
function decideProjectProvider(
  env: Env,
  facts: ProjectProviderFacts,
  request: ProjectProviderRequest
): ProjectProviderDecision {
  switch (request.family) {
    case "custody": {
      const admission = decideCustodySetup(env, facts, {
        ...facts.scope,
        provider: request.provider,
        mode: request.mode,
      });
      if (!admission.admitted) {
        return projectProviderRefusal(
          facts,
          request,
          admission.error.details.reason,
          admission.error
        );
      }
      if (
        request.mode === "managed" &&
        !isProviderConfiguredForProject(env, facts, request.family, request.provider)
      ) {
        return providerNotConfiguredForProject(facts, request);
      }
      return admission;
    }
    case "ramps":
      return decideStagedProvider(facts, request, {
        inReleaseChannel: isRampProviderAvailable(env, request.provider, SDP_RAMP_PROVIDER_STAGES),
        offered: isRampProviderSurfaced(request.provider, facts.environment),
        entry: facts.availability.providers.ramps[request.provider],
        configured: isProviderConfiguredForProject(env, facts, request.family, request.provider),
      });
    case "compliance":
      return decideStagedProvider(facts, request, {
        inReleaseChannel: isModuleAvailable(env, "compliance", SDP_RAMP_PROVIDER_STAGES),
        // Compliance has no surfacing table: every compliance provider is offered.
        offered: true,
        entry: facts.availability.providers.compliance[request.provider],
        configured: isProviderConfiguredForProject(env, facts, request.family, request.provider),
      });
    case "earn":
      return decideStagedProvider(facts, request, {
        inReleaseChannel: isEarnEnabled(env),
        // An existing program ignores surfacing (ADR 0002 exit safety).
        offered: "program" in request || isEarnProviderSurfaced(request.provider),
        entry: facts.availability.providers.earn[request.provider],
        configured: isProviderConfiguredForProject(env, facts, request.family, request.provider),
      });
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown provider family: ${String(exhaustive)}`);
    }
  }
}

/**
 * Logs a project provider refusal a request is being refused with.
 *
 * @param refusal - What was refused, for which project, and why.
 * @param refusal.scope - The project the provider was refused for.
 * @param refusal.environment - The project's environment.
 * @param refusal.request - The refused provider (and, for custody, its mode).
 * @param refusal.reason - The failed check.
 */
function logProjectProviderRefusal(refusal: {
  scope: ProjectProviderScope;
  environment: SdpEnvironment;
  request: ProjectProviderRequest;
  reason: ProjectProviderRefusalReason;
}): void {
  logEvent("warn", {
    event: "sdp_api_project_provider_refused",
    organization_id: refusal.scope.organizationId,
    project_id: refusal.scope.projectId,
    environment: refusal.environment,
    ...refusal.request,
    reason: refusal.reason,
  });
}

/**
 * Logs a project provider refusal a request is being refused with. Call it
 * only where the request is refused, never where a decision is merely
 * evaluated.
 *
 * @param refusal - The project provider rule's refusal.
 * @returns The refusal's error, to throw.
 */
export function refuseProjectProvider(refusal: ProjectProviderRefusal): AppError {
  logProjectProviderRefusal(refusal);
  return refusal.error;
}

/**
 * Logs a custody setup refusal a request is being refused with. Call it only
 * where the request is refused, never where an admission is merely evaluated.
 *
 * @param refusal - The custody setup rule's refusal.
 * @returns The refusal's 403, to throw.
 */
export function refuseCustodySetup(refusal: CustodySetupRefusal): CustodySetupRefusedError {
  const { organizationId, projectId, provider, mode } = refusal.request;
  logProjectProviderRefusal({
    scope: { organizationId, projectId },
    environment: refusal.environment,
    request: { family: "custody", provider, mode },
    reason: refusal.error.details.reason,
  });
  return refusal.error;
}

/**
 * A custody provider's entry for a project: the modes the project provider rule
 * admits, and the first failed check for each mode it refuses.
 *
 * @param env - Process environment naming the release channel.
 * @param facts - The project's environment and its organization's provider access.
 * @param provider - The custody provider.
 * @returns The provider's custody entry.
 */
function custodyProviderEntry(
  env: Env,
  facts: ProjectProviderFacts,
  provider: CustodyProvider
): ProjectProviderAvailabilityEntry {
  const decisions = CUSTODY_MODES.map((mode) => ({
    mode,
    decision: decideProjectProvider(env, facts, { family: "custody", provider, mode }),
  }));
  return {
    family: "custody",
    provider,
    modes: decisions.filter(({ decision }) => decision.admitted).map(({ mode }) => mode),
    unavailableModes: decisions.flatMap(({ mode, decision }) =>
      decision.admitted ? [] : [{ mode, reason: decision.reason }]
    ),
  };
}

/**
 * A ramps, compliance or Earn provider's entry for a project: available, or
 * unavailable with the project provider rule's first failed check.
 *
 * @param env - Process environment naming the release channel.
 * @param facts - The project's environment and its organization's provider access.
 * @param request - The provider.
 * @returns The provider's entry.
 */
function stagedProviderEntry(
  env: Env,
  facts: ProjectProviderFacts,
  request: Exclude<ProjectProviderRequest, { family: "custody" }>
): ProjectProviderAvailabilityEntry {
  const decision = decideProjectProvider(env, facts, request);
  return decision.admitted
    ? { ...request, available: true }
    : { ...request, available: false, reason: decision.reason };
}

/**
 * Every family's entries for a project, in each family's provider tuple order.
 *
 * @param env - Process environment naming the release channel.
 * @param facts - The project's environment and its organization's provider access.
 * @param family - The provider family.
 * @returns One entry per provider the deployment knows in `family`.
 */
function projectProviderEntries(
  env: Env,
  facts: ProjectProviderFacts,
  family: OrganizationProviderFamily
): ProjectProviderAvailabilityEntry[] {
  switch (family) {
    case "custody":
      return CUSTODY_PROVIDERS.map((provider) => custodyProviderEntry(env, facts, provider));
    case "compliance":
      return COMPLIANCE_PROVIDERS.map((provider) =>
        stagedProviderEntry(env, facts, { family, provider })
      );
    case "ramps":
      return RAMP_PROVIDERS.map((provider) =>
        stagedProviderEntry(env, facts, { family, provider })
      );
    case "earn":
      return EARN_PROVIDERS.map((provider) =>
        stagedProviderEntry(env, facts, { family, provider })
      );
    default: {
      const exhaustive: never = family;
      throw new Error(`Unknown provider family: ${String(exhaustive)}`);
    }
  }
}

/**
 * Which providers a project can use, and how: every provider the deployment
 * knows, decided by the same rule every entry-point gate applies. Reads the
 * project's environment and its organization's entitlements itself.
 *
 * @param env - Process environment naming the release channel.
 * @param db - Database client for the project and organization rows.
 * @param scope - The project the read is for.
 * @param scope.organizationId - The organization that owns the project.
 * @param scope.projectId - The project the read is for.
 * @returns The project's environment and one entry per provider, in
 *   `ORGANIZATION_PROVIDER_FAMILIES` order.
 * @throws 404 when the project is not an active project of the organization.
 */
export async function getProjectProviderAvailability(
  env: Env,
  db: DatabaseExecutor,
  scope: ProjectProviderScope
): Promise<ProjectProviderAvailability> {
  const facts = await loadProjectProviderFacts(env, db, scope);
  return {
    projectId: scope.projectId,
    environment: facts.environment,
    providers: ORGANIZATION_PROVIDER_FAMILIES.flatMap((family) =>
      projectProviderEntries(env, facts, family)
    ),
  };
}

/**
 * Refuses a project using a provider unless the project provider rule admits
 * it, logging the refusal. Entry points that start provider work call this
 * before any provider call, row write or audit intent.
 *
 * @param env - Process environment naming the release channel.
 * @param db - Database client for the project and organization rows.
 * @param scope - The project the provider is for.
 * @param scope.organizationId - The organization that owns the project.
 * @param scope.projectId - The project using the provider.
 * @param request - The provider being used (and, for custody, its mode).
 * @throws 403 `FORBIDDEN` whose `details.reason` names the failed check. Custody:
 *   `CUSTODY_SETUP_REFUSAL_REASONS`. Ramps, compliance and Earn:
 *   `provider_not_in_release_channel`, `provider_not_offered` or
 *   `provider_not_entitled`. 503 `PROVIDER_NOT_CONFIGURED` with
 *   `details.reason` `provider_not_configured` when the deployment lacks the
 *   provider's credentials for the project's environment (any family; custody
 *   Managed only). 404 when the project is not an active project of the
 *   organization.
 */
export async function assertProjectProviderAdmitted(
  env: Env,
  db: DatabaseExecutor,
  scope: ProjectProviderScope,
  request: ProjectProviderRequest
): Promise<void> {
  const facts = await loadProjectProviderFacts(env, db, scope);
  const decision = decideProjectProvider(env, facts, request);
  if (!decision.admitted) {
    throw refuseProjectProvider(decision);
  }
}

/**
 * Refuses setting up a (custody provider, mode) pair for a project unless the
 * project provider rule admits it, logging the refusal. Managed setup calls
 * this before any provider call, row write or audit intent.
 *
 * @param env - Process environment naming the release channel.
 * @param db - Database client for the project and organization rows.
 * @param request - The pair being set up and the project it is for.
 * @param request.organizationId - The organization that owns the project.
 * @param request.projectId - The project setting up custody.
 * @param request.provider - The custody provider being set up.
 * @param request.mode - The custody mode being set up.
 * @throws 403 `CustodySetupRefusedError` whose `details.reason` names the failed
 *   check (`CUSTODY_SETUP_REFUSAL_REASONS`); 503 `PROVIDER_NOT_CONFIGURED`
 *   (`details.reason` `provider_not_configured`) when Managed custody lacks
 *   deployment credentials; 404 when the project is not an active project of
 *   the organization.
 */
export async function assertCustodySetupAdmitted(
  env: Env,
  db: DatabaseExecutor,
  request: CustodySetupRequest
): Promise<void> {
  await assertProjectProviderAdmitted(env, db, request, {
    family: "custody",
    provider: request.provider,
    mode: request.mode,
  });
}

/**
 * The BYOK form of the custody setup gate, for submission and installation,
 * which serve an idempotent replay before refusing: whether the project may set
 * up a BYOK connection for `provider`, under the custody setup rule the project
 * provider rule applies to custody. A caller that refuses the request throws
 * `refuseCustodySetup(admission)`.
 *
 * @param env - Process environment naming the release channel.
 * @param db - Database client for the project and organization rows.
 * @param scope - The project the connection is for.
 * @param scope.organizationId - The organization that owns the project.
 * @param scope.projectId - The project setting up the connection.
 * @param provider - The custody provider the connection names.
 * @returns Admitted, or the refusal `assertCustodySetupAdmitted` would throw.
 * @throws 404 when the project is not an active project of the organization.
 */
export async function admitByokCustodySetup(
  env: Env,
  db: DatabaseExecutor,
  scope: ProjectProviderScope,
  provider: CustodyProvider
): Promise<CustodySetupAdmission> {
  const facts = await loadProjectProviderFacts(env, db, scope);
  return decideCustodySetup(env, facts, { ...facts.scope, provider, mode: "byok" });
}

/**
 * Decides whether the project's environment allows using Managed custody
 * (Production is BYOK only), from the project's active row. The use gate and
 * every wallet read model decide from this one rule, so a wallet listed as
 * runtime-executable is never refused by the gate for its environment.
 *
 * @param db - Database client for the project row.
 * @param project - The project whose Managed custody use is decided.
 * @param project.organizationId - The organization that owns the project.
 * @param project.projectId - The project whose environment is read.
 * @returns The project's environment and whether it allows Managed custody use.
 * @throws 404 when the project is not an active project of the organization.
 */
async function decideManagedCustodyUse(
  db: DatabaseExecutor,
  project: ProjectProviderScope
): Promise<{ environment: SdpEnvironment; allowed: boolean }> {
  const environment = await loadActiveProjectEnvironment(db, project);
  return { environment, allowed: isCustodyModeAllowedInEnvironment(environment, "managed") };
}

/**
 * The non-throwing form of `assertManagedCustodyUseAllowed`, for read models
 * that report whether a Managed wallet can execute.
 *
 * @param db - Database client for the project row.
 * @param project - The project whose Managed custody use is decided.
 * @param project.organizationId - The organization that owns the project.
 * @param project.projectId - The project whose environment is read.
 * @returns Whether the project's environment allows Managed custody use.
 * @throws 404 when the project is not an active project of the organization.
 */
export async function isManagedCustodyUseAllowed(
  db: DatabaseExecutor,
  project: ProjectProviderScope
): Promise<boolean> {
  return (await decideManagedCustodyUse(db, project)).allowed;
}

/**
 * Refuses using an existing Managed custody config whose project's environment
 * does not allow Managed custody (Production is BYOK only). Setup is refused by
 * the custody setup rule, but a config created before that rule existed would
 * still create wallets and sign, so every Managed use is refused here, before
 * any decrypt, adapter build or provider call. The environment is read from the
 * config's project row, the same read the setup rule makes.
 *
 * @param db - Database client for the project row.
 * @param config - The Managed config about to be used.
 * @param config.organizationId - The organization that owns the config's project.
 * @param config.projectId - The config's project.
 * @param config.provider - The config's custody provider.
 * @throws 403 `CustodySetupRefusedError` with `details.reason`
 *   `custody_mode_not_allowed`; 404 when the project is not an active project
 *   of the organization.
 */
export async function assertManagedCustodyUseAllowed(
  db: DatabaseExecutor,
  config: ProjectProviderScope & { provider: CustodyProvider }
): Promise<void> {
  const { environment, allowed } = await decideManagedCustodyUse(db, config);
  if (allowed) {
    return;
  }
  const error = custodyModeNotAllowed(config.provider, "managed", environment);
  logEvent("warn", {
    event: "sdp_api_custody_use_refused",
    organization_id: config.organizationId,
    project_id: config.projectId,
    environment,
    provider: config.provider,
    mode: "managed",
    reason: error.details.reason,
  });
  throw error;
}

function getAvailabilityMessage(
  _tier: OrganizationTier,
  family: OrganizationProviderFamily,
  providerId: string,
  entry: ProviderAvailabilityEntry
): string {
  const label = getProviderLabel(family, providerId);

  if (!entry.entitled) {
    return `${label} requires manual activation for this organization.`;
  }

  if (!entry.configured) {
    return `${label} is not configured in this environment.`;
  }

  return `${label} is unavailable for this organization.`;
}

/**
 * Refuses an organization using a custody provider it does not have enabled:
 * entitled by its tier or overrides, and configured in this deployment. An
 * organization-level check for the signing runtime, which has no project in
 * scope; custody's environment and stage rules live in the custody setup gate.
 *
 * @param env - Process environment the provider access is evaluated against.
 * @param db - Database client for the organization row.
 * @param organizationId - The organization whose custody config is about to be used.
 * @param provider - The custody provider.
 * @throws 403 `FORBIDDEN` naming the missing entitlement or configuration.
 */
export async function assertCustodyProviderEnabled(
  env: Env,
  db: DatabaseExecutor,
  organizationId: string,
  provider: CustodyProvider
): Promise<void> {
  const access = await getProviderAvailability(env, db, organizationId, MANIFEST_RAMP_STAGES);
  const entry = access.providers.custody[provider];
  if (!entry.enabled) {
    throw new AppError(
      "FORBIDDEN",
      getAvailabilityMessage(access.tier, "custody", provider, entry)
    );
  }
}

/** A ramps or Earn provider a project is about to start provider work with. */
export type StagedProviderGateRequest = Extract<
  ProjectProviderRequest,
  { family: "ramps" | "earn" }
>;

/** The project provider rule for one request's project, deciding without logging. */
export type ProjectProviderVerdict = (request: ProjectProviderRequest) => ProjectProviderDecision;

/**
 * Loads the request's project facts once (its active project row and its
 * organization's provider access) and returns the project provider rule over
 * them, so a request deciding several providers reads the database once.
 * Evaluating is not refusing: a caller that refuses the request with a
 * refusal throws `refuseProjectProvider(decision)`.
 *
 * @param c - Request context carrying the authenticated project scope.
 * @returns The rule's non-logging verdict for any provider of the project.
 * @throws 404 when the project is not an active project of the organization.
 */
export async function loadProjectProviderVerdict(
  c: Context<{ Bindings: Env }>
): Promise<ProjectProviderVerdict> {
  const facts = await loadProjectProviderFacts(c.env, getDb(c.env), {
    organizationId: getAuth(c).organizationId,
    projectId: requireProjectId(c),
  });
  return (request) => decideProjectProvider(c.env, facts, request);
}

/**
 * The provider gate for ramps and Earn money-in: every path that starts
 * provider work for a project calls this before any provider call, claim or
 * row write. Reads the project from the request's authenticated scope and
 * applies the project provider rule (release channel, surfacing, the
 * Production `stable` bar, entitlement and the deployment's credentials for
 * the project's environment) through the same core the availability read
 * uses, logging a refusal. Re-targeting an existing Earn program passes
 * `program: "existing"`, which skips surfacing alone. Webhooks, reconcilers,
 * reads and Earn exits (ADR 0002) never call it.
 *
 * @param c - Request context carrying the authenticated project scope.
 * @param request - The ramps or Earn provider being used (Earn: a new position, or `program: "existing"`).
 * @throws 403 `FORBIDDEN` whose `details.reason` is `provider_not_in_release_channel`,
 *   `provider_not_offered`, `provider_stage_not_allowed` or
 *   `provider_not_entitled`; 503 `PROVIDER_NOT_CONFIGURED` when the deployment
 *   lacks the provider's credentials for the project's environment; 404 when
 *   the project is not an active project of the organization.
 */
export async function assertProviderAvailable(
  c: Context<{ Bindings: Env }>,
  request: StagedProviderGateRequest
): Promise<void> {
  const verdict = await loadProjectProviderVerdict(c);
  const decision = verdict(request);
  if (!decision.admitted) {
    throw refuseProjectProvider(decision);
  }
}

/**
 * Platform-level gate: opening a NEW position with a provider SDP does not
 * currently offer (`EARN_PROVIDER_SURFACING` in @sdp/types).
 *
 * Deliberately NOT folded into `assertProviderAvailable`, which answers an
 * ORGANIZATION-scoped question and whose refusal tells the caller to ask for
 * manual activation. No override lifts this one, so it runs FIRST and says
 * something different — pointing a caller at an activation door that does not
 * exist is worse than a plain "not offered".
 *
 * This is the ONLY place surfacing is allowed to refuse anything. Every
 * money-out route, every read, and re-targeting an existing program ignore it
 * entirely, so un-surfacing a provider can never strand a position taken while
 * it was offered (ADR 0002).
 */
export function assertEarnProviderSurfaced(providerId: EarnProviderId): void {
  if (!isEarnProviderSurfaced(providerId)) {
    throw new AppError(
      "FORBIDDEN",
      `${PROVIDER_AVAILABILITY_DEFINITIONS.earn[providerId].label} is not currently offered.`
    );
  }
}

export function assertRampProviderSurfaced(
  providerId: RampProviderId,
  environment: SdpEnvironment
): void {
  if (!isRampProviderSurfaced(providerId, environment)) {
    throw new AppError(
      "FORBIDDEN",
      `${PROVIDER_AVAILABILITY_DEFINITIONS.ramps[providerId].label} is not currently offered.`
    );
  }
}

/**
 * Exit-safety gate for Earn withdrawals: money OUT must keep working when a
 * provider is commercially disabled for an organization (entitlement off), so
 * funds can never be trapped behind a sales/tier decision. Only the
 * credential/mode check applies here — deposits use the full
 * assertProviderAvailable gate.
 */
export function assertEarnProviderConfigured(
  env: Env,
  providerId: EarnProviderId,
  testMode: boolean
): void {
  const def = PROVIDER_AVAILABILITY_DEFINITIONS.earn[providerId];
  if (!def?.isConfigured(env, testMode)) {
    const mode = testMode ? "sandbox" : "production";
    throw new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `${def?.label ?? providerId} is not configured for ${mode} mode.`
    );
  }
}

export async function getEnabledProviders(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  options: ProviderAvailabilityOptions
) {
  const access = await getProviderAvailability(env, db, organizationId, options);

  return {
    tier: access.tier,
    custody: CUSTODY_PROVIDERS.filter((provider) => access.providers.custody[provider]?.enabled),
    compliance: COMPLIANCE_PROVIDERS.filter(
      (provider) => access.providers.compliance[provider]?.enabled
    ),
    ramps: RAMP_PROVIDERS.filter((provider) => access.providers.ramps[provider]?.enabled),
    earn: EARN_PROVIDERS.filter((provider) => access.providers.earn[provider]?.enabled),
  };
}

export async function syncProviderAccessFromClerk(
  db: DatabaseClient,
  params: {
    organizationId: string;
    clerkOrganization: ClerkOrganizationWithMetadata;
  }
): Promise<{ tier: OrganizationTier; settings: OrganizationSettings | null }> {
  const clerkMetadata = parseClerkOrganizationTierMetadata(params.clerkOrganization);

  // Settings are one JSON column patched by read-merge-write; the row lock keeps
  // this sync from clobbering a concurrent dashboard settings update (and vice
  // versa), matching the updateOrganization handler.
  const { existingSettings, persistedSettings } = await db.transaction(async (tx) => {
    const row = await tx
      .prepare("SELECT settings FROM organizations WHERE id = ? FOR UPDATE")
      .bind(params.organizationId)
      .first<{ settings: string | null }>();

    if (!row) {
      throw new AppError("NOT_FOUND", "Organization not found");
    }

    const existing = parseOrganizationSettings(row.settings);
    const {
      providerOverrides: _staleOverrides,
      enableProductionProject: _staleEnableProduction,
      ...retainedSettings
    } = existing ?? {};
    const nextSettings: OrganizationSettings = {
      ...retainedSettings,
      ...(clerkMetadata.providerOverrides
        ? { providerOverrides: clerkMetadata.providerOverrides }
        : {}),
      ...(clerkMetadata.enableProductionProject ? { enableProductionProject: true } : {}),
    };

    const persisted = hasOwnEntries(nextSettings as Record<string, unknown>) ? nextSettings : null;

    await tx
      .prepare(
        `UPDATE organizations
         SET tier = ?, settings = ?, updated_at = sdp_datetime_now()
         WHERE id = ?`
      )
      .bind(clerkMetadata.tier, toStoredOrganizationSettings(persisted), params.organizationId)
      .run();

    return { existingSettings: existing, persistedSettings: persisted };
  });

  const wasProductionEnabled = existingSettings?.enableProductionProject === true;
  if (wasProductionEnabled !== clerkMetadata.enableProductionProject) {
    logEvent("info", {
      event: "sdp_api_organization_production_enablement_changed",
      organization_id: params.organizationId,
      enable_production_project: clerkMetadata.enableProductionProject,
    });
  }

  return {
    tier: clerkMetadata.tier,
    settings: persistedSettings,
  };
}
