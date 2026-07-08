import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  CUSTODY_PROVIDERS,
  type CustodyProvider,
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
} from "@sdp/types";
import { parsePostgresJson } from "@/db/postgres-utils";
import { AppError } from "@/lib/errors";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
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
};

type ProviderAvailabilityDefinitions = {
  custody: Record<CustodyProvider, ProviderAvailabilityDefinition>;
  rpc: Record<OrganizationRpcProvider, ProviderAvailabilityDefinition>;
  compliance: Record<ComplianceProviderId, ProviderAvailabilityDefinition>;
  ramps: Record<RampProviderId, ProviderAvailabilityDefinition>;
};

function hasEnv(env: Env, key: keyof Env): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasAllEnv(env: Env, keys: readonly (keyof Env)[]): boolean {
  return keys.every((key) => hasEnv(env, key));
}

const PROVIDER_AVAILABILITY_DEFINITIONS = {
  custody: {
    local: {
      label: "Local",
      isConfigured: (env) => hasEnv(env, "CUSTODY_PRIVATE_KEY"),
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
    quicknode: {
      label: "QuickNode",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_QUICKNODE_URL"),
    },
    triton: {
      label: "Triton",
      isConfigured: (env) => hasEnv(env, "SOLANA_RPC_TRITON_URL"),
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
  },
} as const satisfies ProviderAvailabilityDefinitions;

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

function omitProviderOverrides(settings: OrganizationSettings): OrganizationSettings {
  const { providerOverrides: _providerOverrides, ...rest } = settings;
  return rest;
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

  return hasOwnEntries(next as Record<string, unknown>) ? next : undefined;
}

export function parseClerkOrganizationTierMetadata(organization: ClerkOrganizationWithMetadata): {
  tier: OrganizationTier;
  providerOverrides?: OrganizationProviderOverrides;
} {
  const privateMetadata = asRecord(organization.private_metadata);
  const sdp = asRecord(privateMetadata?.sdp);

  return {
    tier: normalizeOrganizationTier(typeof sdp?.tier === "string" ? sdp.tier : undefined),
    providerOverrides: parseProviderOverridesFromClerkMetadata(sdp?.providerOverrides),
  };
}

export async function getOrganizationTierState(
  db: DatabaseClient,
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
  };
}

/**
 * Self-hosted entitlement: every key in `shape` is entitled by default,
 * minus any explicit `false` overrides (disable-only).
 *
 * `shape` is used only as a key set — its values are ignored, since
 * self-hosted bypasses tier-based entitlement.
 */
function applySelfHostedEntitlements<T extends string>(
  shape: Record<T, boolean>,
  overrides?: Partial<Record<T, boolean>>
): Record<T, boolean> {
  const next = {} as Record<T, boolean>;
  for (const key of Object.keys(shape) as T[]) {
    next[key] = overrides?.[key] !== false;
  }
  return next;
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
  db: DatabaseClient,
  organizationId: string
): Promise<OrganizationProviderAvailabilityResponse> {
  const organization = await getOrganizationTierState(db, organizationId);
  const resolved = resolveOrganizationProviderEntitlements({
    tier: organization.tier,
    providerOverrides: organization.settings?.providerOverrides,
  });
  const configured = getConfiguredProviders(env);

  let entitled = resolved.providers;
  if (isSelfHostedDeployment(env)) {
    const overrides = organization.settings?.providerOverrides;
    entitled = {
      custody: applySelfHostedEntitlements(entitled.custody, overrides?.custody),
      rpc: applySelfHostedEntitlements(entitled.rpc, overrides?.rpc),
      compliance: applySelfHostedEntitlements(entitled.compliance, overrides?.compliance),
      ramps: applySelfHostedEntitlements(entitled.ramps, overrides?.ramps),
    };
  }

  return {
    tier: resolved.tier,
    providers: {
      custody: buildAvailabilityEntries(entitled.custody, configured.custody),
      rpc: buildAvailabilityEntries(entitled.rpc, configured.rpc),
      compliance: buildAvailabilityEntries(entitled.compliance, configured.compliance),
      ramps: buildAvailabilityEntries(entitled.ramps, configured.ramps),
    },
  };
}

function getAvailabilityMessage(
  env: Env,
  tier: OrganizationTier,
  family: OrganizationProviderFamily,
  providerId: string,
  entry: ProviderAvailabilityEntry
): string {
  const label = getProviderLabel(family, providerId);

  if (!entry.entitled) {
    if (isSelfHostedDeployment(env)) {
      return `${label} is disabled for this organization.`;
    }
    return tier === "individual"
      ? `${label} is only available on the enterprise tier.`
      : `${label} is not enabled for this organization.`;
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
        env,
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

  // Secondary mode-specific check for ramps: the general availability check uses
  // a union of sandbox + production credentials, but the runtime handler only uses
  // credentials for the requested mode. Re-check with the specific mode so callers
  // get a clear PROVIDER_NOT_CONFIGURED (503) instead of a silent runtime failure.
  if (family === "ramps" && testMode !== undefined) {
    const def = PROVIDER_AVAILABILITY_DEFINITIONS.ramps[providerId as RampProviderId];
    if (def && !def.isConfigured(env, testMode)) {
      const mode = testMode ? "sandbox" : "production";
      throw new AppError(
        "PROVIDER_NOT_CONFIGURED",
        `${def.label} is not configured for ${mode} mode.`
      );
    }
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
  };
}

export async function syncProviderAccessFromClerk(
  db: DatabaseClient,
  params: {
    organizationId: string;
    clerkOrganization: ClerkOrganizationWithMetadata;
  }
): Promise<{ tier: OrganizationTier; settings: OrganizationSettings | null }> {
  const existing = await getOrganizationTierState(db, params.organizationId);
  const clerkMetadata = parseClerkOrganizationTierMetadata(params.clerkOrganization);

  const nextSettings: OrganizationSettings = clerkMetadata.providerOverrides
    ? {
        ...(existing.settings ?? {}),
        providerOverrides: clerkMetadata.providerOverrides,
      }
    : omitProviderOverrides(existing.settings ?? {});

  const persistedSettings = hasOwnEntries(nextSettings as Record<string, unknown>)
    ? nextSettings
    : null;

  await db
    .prepare(
      `UPDATE organizations
       SET tier = ?, settings = ?, updated_at = sdp_datetime_now()
       WHERE id = ?`
    )
    .bind(
      clerkMetadata.tier,
      toStoredOrganizationSettings(persistedSettings),
      params.organizationId
    )
    .run();

  return {
    tier: clerkMetadata.tier,
    settings: persistedSettings,
  };
}
