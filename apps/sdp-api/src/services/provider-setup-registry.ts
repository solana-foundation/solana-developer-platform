import type { ResolvedRpcTarget } from "@sdp/rpc/relay";
import type {
  ComplianceProviderId,
  CustodyProvider,
  OrganizationRpcProvider,
  RampProviderId,
} from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { isProviderConfigured } from "@/services/provider-availability.service";
import {
  cancelProviderCredentialInstallation,
  completeProviderCredentialInstallation,
} from "@/services/provider-credential-installation.service";
import {
  replaceProviderCredential,
  submitProviderCredential,
} from "@/services/provider-credential-submission.service";
import { isCustomerSuppliedTarget } from "@/services/rpc-egress";
import { probeRpcEndpoint } from "@/services/rpc-probe";
import type { Env } from "@/types/env";

export const PROVIDER_SETUP_FAMILIES = ["custody", "rpc", "compliance", "ramps"] as const;
export type ProviderSetupFamily = (typeof PROVIDER_SETUP_FAMILIES)[number];

type ProviderIdByFamily = {
  custody: CustodyProvider;
  rpc: OrganizationRpcProvider;
  compliance: ComplianceProviderId;
  ramps: RampProviderId;
};

/** Who owns setup for the current first-party integration. */
export type ProviderSetupMode = "self_service" | "platform_managed" | "contact";

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
    appId: z.string().trim().min(1),
    appSecret: z.string().min(1),
  })
  .strict();

const privyCredentialSetupBaseSchema = z.object({
  provider: z.literal("privy"),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().trim().min(1).max(100).optional(),
});

const privyCredentialSubmissionSchema = privyCredentialSetupBaseSchema
  .extend({ fields: privyCredentialFieldsSchema.optional() })
  .strict();

const privyCredentialReplacementSchema = privyCredentialSetupBaseSchema
  .extend({ fields: privyCredentialFieldsSchema })
  .strict();

export type PrivyCredentialSubmissionPayload = z.infer<typeof privyCredentialSubmissionSchema>;
export type PrivyCredentialReplacementPayload = z.infer<typeof privyCredentialReplacementSchema>;

type PrivySetupOperation = "submit" | "replace";

type PrivyStoreCredentialsInput =
  | {
      context: AppContext;
      idempotencyKey: string;
      payload: PrivyCredentialSubmissionPayload;
      connectionId?: undefined;
    }
  | {
      context: AppContext;
      idempotencyKey: string;
      payload: PrivyCredentialReplacementPayload;
      connectionId: string;
    };

interface PrivyConnectionOperationInput {
  context: AppContext;
  connectionId: string;
}

function validatePrivySetupPayload(
  payload: unknown,
  operation: "submit"
): ReturnType<typeof privyCredentialSubmissionSchema.safeParse>;
function validatePrivySetupPayload(
  payload: unknown,
  operation: "replace"
): ReturnType<typeof privyCredentialReplacementSchema.safeParse>;
function validatePrivySetupPayload(payload: unknown, operation: PrivySetupOperation) {
  return operation === "replace"
    ? privyCredentialReplacementSchema.safeParse(payload)
    : privyCredentialSubmissionSchema.safeParse(payload);
}

async function storePrivyCredentials(input: PrivyStoreCredentialsInput) {
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

export interface RpcConnectionCheckInput {
  target: ResolvedRpcTarget;
}

export interface RpcConnectionCheckResult {
  elapsedMs: number;
  upstream: Response;
  upstreamBody: unknown;
}

/**
 * Run the same read-only JSON-RPC probe used by POST /rpc/test.
 *
 * `/v1/rpc/test` resolves tenant connections and the project's own `custom`
 * endpoint, and `projects.settings.rpcEndpoint` behind the latter is validated
 * as a URL when written and nothing more, so the probe reaches a
 * customer-supplied host in both cases and both go under the guard. Managed
 * providers keep the ordinary fetch: their endpoints come from deployment
 * config and are private on purpose in local development and in the Surfpool
 * suites. The probe does not follow redirects, which it already refused before
 * the guard existed.
 */
export async function checkResolvedRpcTargetConnection(
  input: RpcConnectionCheckInput
): Promise<RpcConnectionCheckResult> {
  return probeRpcEndpoint(input.target, {
    enforcePublicEgress: isCustomerSuppliedTarget(input.target),
  });
}

export interface ProviderConfigurationCheckInput {
  env: Env;
  testMode?: boolean;
}

export interface ProviderConfigurationCheckResult {
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

function rpcSetup<const Provider extends OrganizationRpcProvider>(provider: Provider) {
  return {
    family: "rpc",
    provider,
    setupMode: "platform_managed",
    checkConnection: checkResolvedRpcTargetConnection,
  } as const;
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
    fireblocks: { family: "custody", provider: "fireblocks", setupMode: "contact" },
    privy: {
      family: "custody",
      provider: "privy",
      setupMode: "self_service",
      validateSetupPayload: validatePrivySetupPayload,
      storeCredentials: storePrivyCredentials,
      activate: ({ context, connectionId }: PrivyConnectionOperationInput) =>
        completeProviderCredentialInstallation(context, connectionId),
      deactivate: ({ context, connectionId }: PrivyConnectionOperationInput) =>
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
  rpc: {
    alchemy: rpcSetup("alchemy"),
    default: rpcSetup("default"),
    helius: rpcSetup("helius"),
    nodit: rpcSetup("nodit"),
    quicknode: rpcSetup("quicknode"),
    triton: rpcSetup("triton"),
    validationcloud: rpcSetup("validationcloud"),
  },
  compliance: {
    range: complianceSetup("range"),
    elliptic: complianceSetup("elliptic"),
    trm: complianceSetup("trm"),
    chainalysis: complianceSetup("chainalysis"),
  },
  ramps: {
    moonpay: rampSetup("moonpay"),
    lightspark: rampSetup("lightspark"),
    bvnk: rampSetup("bvnk"),
    moneygram: rampSetup("moneygram"),
    coinbase: rampSetup("coinbase"),
    mural: rampSetup("mural"),
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
