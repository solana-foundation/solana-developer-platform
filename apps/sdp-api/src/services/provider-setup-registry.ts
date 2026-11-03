import type { CustodyProvider } from "@sdp/types/custody";
import type { ComplianceProviderId, RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import { z } from "zod";
import {
  fireblocksRegistrationSchema,
  privyAuthenticationSchema,
} from "@/services/custody/byok-credential";
import { isProviderConfigured } from "@/services/provider-availability.service";
import {
  cancelProviderCredentialInstallation,
  completeProviderCredentialInstallation,
} from "@/services/provider-credential-installation.service";
import {
  replaceProviderCredential,
  submitProviderCredential,
} from "@/services/provider-credential-submission.service";
import type { Env } from "@/types/env";

const PROVIDER_SETUP_FAMILIES = ["custody", "compliance", "ramps"] as const;
export type ProviderSetupFamily = (typeof PROVIDER_SETUP_FAMILIES)[number];

type ProviderIdByFamily = {
  custody: CustodyProvider;
  compliance: ComplianceProviderId;
  ramps: RampProviderId;
};

/** Who owns setup for the current first-party integration. */
type ProviderSetupMode = "self_service" | "platform_managed" | "contact";

type ProviderSetupHook = (...args: never[]) => unknown;

interface ProviderSetupDefinition<
  Family extends ProviderSetupFamily,
  Provider extends ProviderIdByFamily[Family],
> {
  family: Family;
  provider: Provider;
  setupMode: ProviderSetupMode;
  validateSetupPayload?: ProviderSetupHook;
  storeCredentials?: ProviderSetupHook;
  checkConnection?: ProviderSetupHook;
  activate?: ProviderSetupHook;
  deactivate?: ProviderSetupHook;
}

type ProviderSetupRegistryShape = {
  [Family in ProviderSetupFamily]: {
    [Provider in ProviderIdByFamily[Family]]: ProviderSetupDefinition<Family, Provider>;
  };
};

type AppContext = Context<{ Bindings: Env }>;

const privyCredentialFieldsSchema = z
  .object({
    credentialLabel: z.string().trim().min(1),
    scope: z.literal("project"),
    ...privyAuthenticationSchema.shape,
  })
  .strict();

const privyCredentialSetupBaseSchema = z.object({
  provider: z.literal("privy"),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().trim().min(1).max(100).optional(),
});

const privyCredentialSetupSchema = privyCredentialSetupBaseSchema
  .extend({ fields: privyCredentialFieldsSchema })
  .strict();

const fireblocksCredentialSetupSchema = privyCredentialSetupBaseSchema
  .extend({
    provider: z.literal("fireblocks"),
    fireblocksVaultAccountIds: z
      .array(z.string().regex(/^\d{1,100}$/))
      .min(1)
      .max(20)
      .optional(),
    fields: privyCredentialFieldsSchema
      .omit({ appId: true, appSecret: true })
      .extend(fireblocksRegistrationSchema.shape)
      .strict(),
  })
  .strict()
  .refine(
    (input) =>
      !input.fireblocksVaultAccountIds ||
      (input.fireblocksVaultAccountIds.includes(input.fields.vaultAccountId) &&
        new Set(input.fireblocksVaultAccountIds).size === input.fireblocksVaultAccountIds.length),
    "Select distinct vaults including the connection's signing vault"
  );
const custodyCredentialSetupSchema = z.discriminatedUnion("provider", [
  privyCredentialSetupSchema,
  fireblocksCredentialSetupSchema,
]);
export function validateCustodySetupPayload(payload: unknown) {
  return custodyCredentialSetupSchema.safeParse(payload);
}

interface CustodyStoreCredentialsInput {
  context: AppContext;
  idempotencyKey: string;
  payload: z.infer<typeof custodyCredentialSetupSchema>;
  connectionId?: string;
}

interface CustodyConnectionOperationInput {
  context: AppContext;
  connectionId: string;
}

function validatePrivySetupPayload(payload: unknown) {
  return privyCredentialSetupSchema.safeParse(payload);
}

export async function storeCustodyCredentials(input: CustodyStoreCredentialsInput) {
  if (input.connectionId) {
    return replaceProviderCredential(
      input.context,
      input.connectionId,
      input.payload,
      input.idempotencyKey
    );
  }
  return submitProviderCredential(input.context, input.payload, input.idempotencyKey);
}

interface ProviderConfigurationCheckInput {
  env: Env;
  testMode?: boolean;
}

interface ProviderConfigurationCheckResult {
  kind: "configuration";
  status: "configured" | "not_configured";
  checkedAt: string;
}

function complianceConfigurationCheck(provider: ComplianceProviderId) {
  return (input: ProviderConfigurationCheckInput): ProviderConfigurationCheckResult => ({
    kind: "configuration",
    status: isProviderConfigured(input.env, "compliance", provider, input.testMode)
      ? "configured"
      : "not_configured",
    checkedAt: new Date().toISOString(),
  });
}

function rampConfigurationCheck(provider: RampProviderId) {
  return (input: ProviderConfigurationCheckInput): ProviderConfigurationCheckResult => ({
    kind: "configuration",
    status: isProviderConfigured(input.env, "ramps", provider, input.testMode)
      ? "configured"
      : "not_configured",
    checkedAt: new Date().toISOString(),
  });
}

function complianceSetup<const Provider extends ComplianceProviderId>(provider: Provider) {
  return {
    family: "compliance",
    provider,
    setupMode: "contact",
    checkConnection: complianceConfigurationCheck(provider),
  } as const;
}

function rampSetup<const Provider extends RampProviderId>(provider: Provider) {
  return {
    family: "ramps",
    provider,
    setupMode: "platform_managed",
    checkConnection: rampConfigurationCheck(provider),
  } as const;
}

/**
 * Static first-party setup adapters. This is deliberately not an extension
 * loader: every provider is imported, typed, and reviewed with the API.
 */
export const PROVIDER_SETUP_REGISTRY = {
  custody: {
    local: { family: "custody", provider: "local", setupMode: "platform_managed" },
    fireblocks: {
      family: "custody",
      provider: "fireblocks",
      setupMode: "self_service",
      validateSetupPayload: (payload: unknown) =>
        fireblocksCredentialSetupSchema.safeParse(payload),
      storeCredentials: storeCustodyCredentials,
      activate: ({ context, connectionId }: CustodyConnectionOperationInput) =>
        completeProviderCredentialInstallation(context, connectionId),
      deactivate: ({ context, connectionId }: CustodyConnectionOperationInput) =>
        cancelProviderCredentialInstallation(context, connectionId),
    },
    privy: {
      family: "custody",
      provider: "privy",
      setupMode: "self_service",
      validateSetupPayload: validatePrivySetupPayload,
      storeCredentials: storeCustodyCredentials,
      activate: ({ context, connectionId }: CustodyConnectionOperationInput) =>
        completeProviderCredentialInstallation(context, connectionId),
      deactivate: ({ context, connectionId }: CustodyConnectionOperationInput) =>
        cancelProviderCredentialInstallation(context, connectionId),
    },
    coinbase_cdp: {
      family: "custody",
      provider: "coinbase_cdp",
      setupMode: "platform_managed",
    },
    para: { family: "custody", provider: "para", setupMode: "platform_managed" },
    turnkey: { family: "custody", provider: "turnkey", setupMode: "platform_managed" },
    dfns: { family: "custody", provider: "dfns", setupMode: "contact" },
    ibm_haven: { family: "custody", provider: "ibm_haven", setupMode: "contact" },
    anchorage: { family: "custody", provider: "anchorage", setupMode: "contact" },
    utila: { family: "custody", provider: "utila", setupMode: "contact" },
  },
  compliance: {
    range: complianceSetup("range"),
    elliptic: complianceSetup("elliptic"),
    trm: complianceSetup("trm"),
    chainalysis: complianceSetup("chainalysis"),
  },
  ramps: {
    moonpay: rampSetup("moonpay"),
    stripe: rampSetup("stripe"),
  },
} as const satisfies ProviderSetupRegistryShape;

export type ProviderSetupRegistry = typeof PROVIDER_SETUP_REGISTRY;

export function getProviderSetupDefinition<
  const Family extends ProviderSetupFamily,
  const Provider extends keyof ProviderSetupRegistry[Family],
>(family: Family, provider: Provider): ProviderSetupRegistry[Family][Provider] {
  return PROVIDER_SETUP_REGISTRY[family][provider];
}
