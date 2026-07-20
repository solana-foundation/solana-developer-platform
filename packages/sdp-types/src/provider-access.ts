import { CUSTODY_PROVIDERS, type CustodyProvider } from "./custody";
import {
  normalizeOrganizationTier,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
  type OrganizationTier,
} from "./organizations";

export const COMPLIANCE_PROVIDERS = ["range", "elliptic", "trm", "chainalysis"] as const;
export type ComplianceProviderId = (typeof COMPLIANCE_PROVIDERS)[number];

export const RAMP_PROVIDERS = [
  "moonpay",
  "lightspark",
  "bvnk",
  "moneygram",
  "coinbase",
  "mural",
  "stripe",
] as const;
export type RampProviderId = (typeof RAMP_PROVIDERS)[number];

/** Vault-infra partners fronting Earn yield strategies. */
export const EARN_PROVIDERS = ["veda", "upshift", "perena", "ground"] as const;
export type EarnProviderId = (typeof EARN_PROVIDERS)[number];

export const ORGANIZATION_PROVIDER_FAMILIES = [
  "custody",
  "rpc",
  "compliance",
  "ramps",
  "earn",
] as const;
export type OrganizationProviderFamily = (typeof ORGANIZATION_PROVIDER_FAMILIES)[number];

export interface OrganizationProviderOverrides {
  custody?: Partial<Record<CustodyProvider, boolean>>;
  rpc?: Partial<Record<OrganizationRpcProvider, boolean>>;
  compliance?: Partial<Record<ComplianceProviderId, boolean>>;
  ramps?: Partial<Record<RampProviderId, boolean>>;
  earn?: Partial<Record<EarnProviderId, boolean>>;
}

export interface ProviderAvailabilityEntry {
  entitled: boolean;
  configured: boolean;
  enabled: boolean;
}

export interface OrganizationProviderAvailability {
  custody: Record<CustodyProvider, ProviderAvailabilityEntry>;
  rpc: Record<OrganizationRpcProvider, ProviderAvailabilityEntry>;
  compliance: Record<ComplianceProviderId, ProviderAvailabilityEntry>;
  ramps: Record<RampProviderId, ProviderAvailabilityEntry>;
  earn: Record<EarnProviderId, ProviderAvailabilityEntry>;
}

export interface OrganizationProviderEntitlements {
  custody: Record<CustodyProvider, boolean>;
  rpc: Record<OrganizationRpcProvider, boolean>;
  compliance: Record<ComplianceProviderId, boolean>;
  ramps: Record<RampProviderId, boolean>;
  earn: Record<EarnProviderId, boolean>;
}

export interface OrganizationProviderAvailabilityResponse {
  tier: OrganizationTier;
  providers: OrganizationProviderAvailability;
}

function createBooleanRecord<const T extends readonly string[]>(
  values: T,
  enabledValues: readonly T[number][]
): Record<T[number], boolean> {
  const enabledSet = new Set<string>(enabledValues);

  return Object.fromEntries(values.map((value) => [value, enabledSet.has(value)])) as Record<
    T[number],
    boolean
  >;
}

function applyOverrides<T extends string>(
  base: Record<T, boolean>,
  overrides?: Partial<Record<T, boolean>>
): Record<T, boolean> {
  if (!overrides) {
    return { ...base };
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "boolean") {
      continue;
    }
    if (key in next) {
      next[key as T] = value;
    }
  }

  return next;
}

const INDIVIDUAL_PROVIDER_DEFAULTS: OrganizationProviderEntitlements = {
  custody: createBooleanRecord(CUSTODY_PROVIDERS, ["privy", "coinbase_cdp", "turnkey"]),
  rpc: createBooleanRecord(ORGANIZATION_RPC_PROVIDERS, ["default", "helius", "triton"]),
  compliance: createBooleanRecord(COMPLIANCE_PROVIDERS, []),
  ramps: createBooleanRecord(RAMP_PROVIDERS, ["moonpay", "moneygram", "stripe"]),
  earn: createBooleanRecord(EARN_PROVIDERS, []),
};

const ENTERPRISE_PROVIDER_DEFAULTS: OrganizationProviderEntitlements = {
  custody: createBooleanRecord(CUSTODY_PROVIDERS, [
    "fireblocks",
    "privy",
    "coinbase_cdp",
    "para",
    "turnkey",
    "dfns",
    "ibm_haven",
    "anchorage",
    "utila",
  ]),
  rpc: createBooleanRecord(ORGANIZATION_RPC_PROVIDERS, [
    "default",
    "alchemy",
    "helius",
    "quicknode",
    "triton",
    "validationcloud",
  ]),
  compliance: createBooleanRecord(COMPLIANCE_PROVIDERS, [
    "range",
    "elliptic",
    "trm",
    "chainalysis",
  ]),
  ramps: createBooleanRecord(RAMP_PROVIDERS, [
    "moonpay",
    "lightspark",
    "bvnk",
    "moneygram",
    "coinbase",
    "mural",
    "stripe",
  ]),
  earn: createBooleanRecord(EARN_PROVIDERS, ["veda", "upshift", "perena", "ground"]),
};

export function resolveOrganizationProviderEntitlements(input: {
  tier: string | null | undefined;
  providerOverrides?: OrganizationProviderOverrides | null;
}): { tier: OrganizationTier; providers: OrganizationProviderEntitlements } {
  const tier = normalizeOrganizationTier(input.tier);
  const defaults =
    tier === "enterprise" ? ENTERPRISE_PROVIDER_DEFAULTS : INDIVIDUAL_PROVIDER_DEFAULTS;

  return {
    tier,
    providers: {
      custody: applyOverrides(defaults.custody, input.providerOverrides?.custody),
      rpc: applyOverrides(defaults.rpc, input.providerOverrides?.rpc),
      compliance: applyOverrides(defaults.compliance, input.providerOverrides?.compliance),
      ramps: applyOverrides(defaults.ramps, input.providerOverrides?.ramps),
      earn: applyOverrides(defaults.earn, input.providerOverrides?.earn),
    },
  };
}
