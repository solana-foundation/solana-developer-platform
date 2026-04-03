import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  ORGANIZATION_RPC_PROVIDERS,
  RAMP_PROVIDERS,
  type ComplianceProviderId,
  type CustodyProvider,
  type OrganizationProviderAvailabilityResponse,
  type OrganizationProviderFamily,
  type OrganizationProviderOverrides,
  type OrganizationRpcProvider,
  type OrganizationSettings,
  type OrganizationTier,
  type ProviderAvailabilityEntry,
  type RampProviderId,
  normalizeOrganizationTier,
  resolveOrganizationProviderEntitlements,
} from "@sdp/types";

type OrganizationProviderRow = {
  tier: string;
  settings: string | null;
};

type ClerkOrganizationWithMetadata = {
  id: string;
  private_metadata?: unknown;
};

const PROVIDER_LABELS = {
  custody: {
    local: "Local",
    fireblocks: "Fireblocks",
    privy: "Privy",
    coinbase_cdp: "Coinbase CDP",
    para: "Para",
    turnkey: "Turnkey",
    dfns: "DFNS",
    anchorage: "Anchorage",
  },
  rpc: {
    default: "SDP/default",
    alchemy: "Alchemy",
    helius: "Helius",
    quicknode: "QuickNode",
    triton: "Triton",
  },
  compliance: {
    range: "Range",
    elliptic: "Elliptic",
    trm: "TRM",
    chainalysis: "Chainalysis",
  },
  ramps: {
    moonpay: "MoonPay",
    lightspark: "Lightspark",
    bvnk: "BVNK",
  },
} as const;

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
    return JSON.parse(raw) as OrganizationSettings;
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

  return hasOwnEntries(next as Record<string, unknown>) ? next : undefined;
}

export function parseClerkOrganizationTierMetadata(
  organization: ClerkOrganizationWithMetadata
): {
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

function getConfiguredProviders(env: Env) {
  return {
    custody: {
      local: true,
      fireblocks: Boolean(env.FIREBLOCKS_API_KEY?.trim() && env.FIREBLOCKS_API_SECRET?.trim()),
      privy: Boolean(env.PRIVY_APP_ID?.trim() && env.PRIVY_APP_SECRET?.trim()),
      coinbase_cdp: Boolean(
        env.COINBASE_CDP_API_KEY_ID?.trim() &&
          env.COINBASE_CDP_API_KEY_SECRET?.trim() &&
          env.COINBASE_CDP_WALLET_SECRET?.trim()
      ),
      para: Boolean(env.PARA_API_KEY?.trim()),
      turnkey: Boolean(
        env.TURNKEY_API_PUBLIC_KEY?.trim() &&
          env.TURNKEY_API_PRIVATE_KEY?.trim() &&
          env.TURNKEY_ORGANIZATION_ID?.trim()
      ),
      dfns: Boolean(
        env.DFNS_AUTH_TOKEN?.trim() &&
          env.DFNS_CREDENTIAL_ID?.trim() &&
          env.DFNS_PRIVATE_KEY?.trim()
      ),
      anchorage: Boolean(env.ANCHORAGE_API_KEY?.trim()),
    },
    rpc: {
      default: Boolean(env.SOLANA_RPC_URL?.trim()),
      alchemy: Boolean(env.SOLANA_RPC_ALCHEMY_URL?.trim()),
      helius: Boolean(env.SOLANA_RPC_HELIUS_URL?.trim()),
      quicknode: Boolean(env.SOLANA_RPC_QUICKNODE_URL?.trim()),
      triton: Boolean(env.SOLANA_RPC_TRITON_URL?.trim()),
    },
    compliance: {
      range: Boolean(env.RANGE_API_KEY?.trim()),
      elliptic: Boolean(
        env.ELLIPTIC_API_TOKEN?.trim() ||
          (env.ELLIPTIC_API_KEY?.trim() && env.ELLIPTIC_API_SECRET?.trim())
      ),
      trm: Boolean(env.TRM_API_KEY?.trim()),
      chainalysis: Boolean(env.CHAINALYSIS_API_KEY?.trim()),
    },
    ramps: {
      moonpay: Boolean(env.MOONPAY_API_KEY?.trim() && env.MOONPAY_SECRET_KEY?.trim()),
      lightspark: Boolean(
        env.LIGHTSPARK_GRID_CLIENT_ID?.trim() && env.LIGHTSPARK_GRID_CLIENT_SECRET?.trim()
      ),
      bvnk: Boolean(
        env.BVNK_WALLET_ID?.trim() &&
          (env.BVNK_API_TOKEN?.trim() ||
            (env.BVNK_HAWK_AUTH_ID?.trim() && env.BVNK_HAWK_SECRET_KEY?.trim()))
      ),
    },
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

export async function getOrganizationProviderAvailability(
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

  return {
    tier: resolved.tier,
    providers: {
      custody: buildAvailabilityEntries(resolved.providers.custody, configured.custody),
      rpc: buildAvailabilityEntries(resolved.providers.rpc, configured.rpc),
      compliance: buildAvailabilityEntries(resolved.providers.compliance, configured.compliance),
      ramps: buildAvailabilityEntries(resolved.providers.ramps, configured.ramps),
    },
  };
}

function getAvailabilityMessage(
  tier: OrganizationTier,
  family: OrganizationProviderFamily,
  providerId: string,
  entry: ProviderAvailabilityEntry
): string {
  const label =
    PROVIDER_LABELS[family][providerId as keyof (typeof PROVIDER_LABELS)[typeof family]] ??
    providerId;

  if (!entry.entitled) {
    return tier === "free"
      ? `${label} is only available on the enterprise tier.`
      : `${label} is not enabled for this organization.`;
  }

  if (!entry.configured) {
    return `${label} is not configured in this environment.`;
  }

  return `${label} is unavailable for this organization.`;
}

export async function assertOrganizationProviderEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "custody",
  providerId: CustodyProvider
): Promise<void>;
export async function assertOrganizationProviderEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "rpc",
  providerId: OrganizationRpcProvider
): Promise<void>;
export async function assertOrganizationProviderEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "compliance",
  providerId: ComplianceProviderId
): Promise<void>;
export async function assertOrganizationProviderEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: "ramps",
  providerId: RampProviderId
): Promise<void>;
export async function assertOrganizationProviderEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string,
  family: OrganizationProviderFamily,
  providerId: string
): Promise<void> {
  const access = await getOrganizationProviderAvailability(env, db, organizationId);
  const entry = access.providers[family][
    providerId as keyof (typeof access.providers)[typeof family]
  ] as ProviderAvailabilityEntry | undefined;

  if (!entry?.enabled) {
    throw new AppError(
      "FORBIDDEN",
      getAvailabilityMessage(access.tier, family, providerId, entry ?? {
        entitled: false,
        configured: false,
        enabled: false,
      })
    );
  }
}

export async function getEnabledOrganizationProviders(
  env: Env,
  db: DatabaseClient,
  organizationId: string
) {
  const access = await getOrganizationProviderAvailability(env, db, organizationId);

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

export async function syncOrganizationTierFromClerk(
  db: DatabaseClient,
  params: {
    organizationId: string;
    clerkOrganization: ClerkOrganizationWithMetadata;
  }
): Promise<{ tier: OrganizationTier; settings: OrganizationSettings | null }> {
  const existing = await getOrganizationTierState(db, params.organizationId);
  const clerkMetadata = parseClerkOrganizationTierMetadata(params.clerkOrganization);

  const nextSettings: OrganizationSettings = {
    ...(existing.settings ?? {}),
  };

  if (clerkMetadata.providerOverrides) {
    nextSettings.providerOverrides = clerkMetadata.providerOverrides;
  } else {
    delete nextSettings.providerOverrides;
  }

  const persistedSettings = hasOwnEntries(nextSettings as Record<string, unknown>)
    ? nextSettings
    : null;

  await db
    .prepare(
      `UPDATE organizations
       SET tier = ?, settings = ?, updated_at = sdp_datetime_now()
       WHERE id = ?`
    )
    .bind(clerkMetadata.tier, toStoredOrganizationSettings(persistedSettings), params.organizationId)
    .run();

  return {
    tier: clerkMetadata.tier,
    settings: persistedSettings,
  };
}
