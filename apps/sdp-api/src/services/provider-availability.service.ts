import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  CUSTODY_PROVIDER_CATALOG_BY_ID,
  CUSTODY_PROVIDERS,
  type CustodyProvider,
  EARN_PROVIDERS,
  type EarnProviderId,
  isEarnProviderSurfaced,
  isRampProviderSurfaced,
  normalizeOrganizationTier,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationProviderAvailabilityResponse,
  type OrganizationProviderFamily,
  type OrganizationProviderOverrides,
  type OrganizationRpcProvider,
  type OrganizationSettings,
  type OrganizationTier,
  type ProviderAvailabilityEntry,
  RAMP_PROVIDERS,
  type RampProviderId,
  resolveOrganizationProviderEntitlements,
  type SdpEnvironment,
} from "@sdp/types";
import type { DatabaseExecutor } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { AppError } from "@/lib/errors";
import { isCustodyConnectionRuntimeEnabled } from "@/lib/feature-flags";
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
  rpc: Record<OrganizationRpcProvider, ProviderAvailabilityDefinition>;
  compliance: Record<ComplianceProviderId, ProviderAvailabilityDefinition>;
  ramps: Record<RampProviderId, ProviderAvailabilityDefinition>;
  earn: Record<EarnProviderId, ProviderAvailabilityDefinition>;
};

type ProviderIdByFamily = {
  custody: CustodyProvider;
  rpc: OrganizationRpcProvider;
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
type KeyPairedEarnProviderId = Exclude<EarnProviderId, "kamino" | "veda" | "jupiter_lend">;

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
  rpc: {
    default: {
      label: "SDP/default",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_URL"),
    },
    alchemy: {
      label: "Alchemy",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_ALCHEMY_URL"),
    },
    helius: {
      label: "Helius",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_HELIUS_URL"),
    },
    nodit: {
      label: "Nodit",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_NODIT_URL"),
    },
    quicknode: {
      label: "QuickNode",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_QUICKNODE_URL"),
    },
    triton: {
      label: "Triton",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_TRITON_URL"),
    },
    validationcloud: {
      label: "Validation Cloud",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_VALIDATIONCLOUD_URL"),
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
    hercle: {
      label: "Hercle",
      isConfigured: (env, testMode) => {
        const prod = hasAllEnv(env, [
          "HERCLE_CLIENT_ID",
          "HERCLE_CLIENT_SECRET",
          "HERCLE_API_BASE_URL",
        ]);
        const sandbox = hasAllEnv(env, [
          "HERCLE_SANDBOX_CLIENT_ID",
          "HERCLE_SANDBOX_CLIENT_SECRET",
          "HERCLE_SANDBOX_API_BASE_URL",
        ]);
        if (testMode === true) return sandbox;
        if (testMode === false) return prod;
        return prod || sandbox;
      },
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
    ground: keyPairCredentialDefinition("Ground", "GROUND"),
    kamino: publicApiDefinition("Kamino"),
    jupiter_lend: publicApiDefinition("Jupiter Lend"),
  },
} as const satisfies ProviderAvailabilityDefinitions;

/**
 * Every env key an earn availability definition actually reads — the drift
 * guard's source of truth (provider-availability.drift.test.ts), which checks
 * these against turbo.json globalEnv and scripts/secret-keys.mjs.
 *
 * Derived from the definitions rather than from `EARN_PROVIDERS` by naming
 * convention, so it stays correct for a provider that needs no credential and
 * for any future one whose credential is not a key pair.
 */
export const EARN_CREDENTIAL_ENV_KEYS: readonly string[] = Object.values(
  PROVIDER_AVAILABILITY_DEFINITIONS.earn
).flatMap((definition) => definition.credentialEnvKeys ?? []);

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

  const rpc = parseBooleanOverrides(record.rpc, ORGANIZATION_RPC_PROVIDERS);
  if (rpc) {
    next.rpc = rpc;
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
    rpc: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.rpc, env),
    compliance: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.compliance, env),
    ramps: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.ramps, env),
    earn: buildConfiguredProviderEntries(PROVIDER_AVAILABILITY_DEFINITIONS.earn, env),
  };
}

function buildAvailabilityEntries<T extends string>(
  entitled: Record<T, boolean>,
  configured: Record<T, boolean>
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
          enabled: isEntitled && isConfigured,
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

export async function getProviderAvailability(
  env: Env,
  db: DatabaseExecutor,
  organizationId: string
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
      custody: buildAvailabilityEntries(resolved.providers.custody, configured.custody),
      rpc: buildAvailabilityEntries(resolved.providers.rpc, configured.rpc),
      compliance: buildAvailabilityEntries(resolved.providers.compliance, configured.compliance),
      ramps: buildAvailabilityEntries(resolved.providers.ramps, configured.ramps),
      earn: buildAvailabilityEntries(resolved.providers.earn, configured.earn),
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
  const availability = await getProviderAvailability(env, db, organizationId);
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
      )
    );
  }
}

export async function isPersistedCustodyCompletionEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  provider: CustodyProvider,
  source: "stored" | "runtime"
): Promise<boolean> {
  if (!isCustodyConnectionRuntimeEnabled(env, provider)) {
    return false;
  }

  if (
    source === "stored" &&
    CUSTODY_PROVIDER_CATALOG_BY_ID[provider].storedCredentialSetup.mode !== "self_service"
  ) {
    return false;
  }

  const availability = await getProviderAvailability(env, db, organizationId);
  const providerAvailability = availability.providers.custody[provider];
  return source === "runtime"
    ? providerAvailability?.enabled === true
    : providerAvailability?.entitled === true;
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

export async function assertProviderAvailable(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "custody",
  providerId: CustodyProvider
): Promise<void>;
export async function assertProviderAvailable(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "rpc",
  providerId: OrganizationRpcProvider
): Promise<void>;
export async function assertProviderAvailable(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "compliance",
  providerId: ComplianceProviderId
): Promise<void>;
export async function assertProviderAvailable(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "ramps",
  providerId: RampProviderId,
  testMode: boolean
): Promise<void>;
export async function assertProviderAvailable(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "earn",
  providerId: EarnProviderId,
  testMode: boolean
): Promise<void>;
export async function assertProviderAvailable(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: OrganizationProviderFamily,
  providerId: string,
  testMode?: boolean
): Promise<void> {
  const access = await getProviderAvailability(env, db, organizationId);
  const entry = access.providers[family][
    providerId as keyof (typeof access.providers)[typeof family]
  ] as ProviderAvailabilityEntry | undefined;

  if (!entry?.enabled) {
    throw new AppError(
      "FORBIDDEN",
      getAvailabilityMessage(
        access.tier,
        family,
        providerId,
        entry ?? {
          entitled: false,
          configured: false,
          enabled: false,
        }
      )
    );
  }

  // Secondary mode-specific check for ramps/earn: the general availability check
  // uses a union of sandbox + production credentials, but the runtime handler only
  // uses credentials for the requested mode. Re-check with the specific mode so
  // callers get a clear PROVIDER_NOT_CONFIGURED (503) instead of a silent runtime
  // failure.
  if ((family === "ramps" || family === "earn") && testMode !== undefined) {
    const definitions = PROVIDER_AVAILABILITY_DEFINITIONS[family] as Record<
      string,
      ProviderAvailabilityDefinition
    >;
    const def = definitions[providerId];
    if (def && !def.isConfigured(env, testMode)) {
      const mode = testMode ? "sandbox" : "production";
      throw new AppError(
        "PROVIDER_NOT_CONFIGURED",
        `${def.label} is not configured for ${mode} mode.`
      );
    }
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

export async function getEnabledProviders(env: Env, db: DatabaseClient, organizationId: string) {
  const access = await getProviderAvailability(env, db, organizationId);

  return {
    tier: access.tier,
    custody: CUSTODY_PROVIDERS.filter((provider) => access.providers.custody[provider]?.enabled),
    rpc: ORGANIZATION_RPC_PROVIDERS.filter((provider) => access.providers.rpc[provider]?.enabled),
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
