import type { PaymentRampExecution, SdpEnvironment } from "@sdp/types";
import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  RAMP_SUPPORT_HASH,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp-support";
import type { RampProviderId } from "@sdp/types/provider-access";
import { getDb } from "@/db";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import type { BvnkComplianceInput, RampRuntimeContext } from "@/lib/ramps/types";
import { success } from "@/lib/response";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { assertWalletPolicyAllowsTransfer } from "../policy";
import {
  createOfframpQuoteSchema,
  createOnrampQuoteSchema,
  executeOfframpSchema,
  executeOnrampSchema,
  listOfframpCurrenciesQuerySchema,
  listOnrampCurrenciesQuerySchema,
  simulateSandboxTransferSchema,
} from "../schemas";
import { resolveScope, resolveWalletAddress } from "../wallets";

type OnrampCurrencyPair = {
  source: (typeof ONRAMP_SUPPORT)[number]["source"];
  dest: (typeof ONRAMP_SUPPORT)[number]["dest"];
  providers: RampProviderId[];
};

type OfframpCurrencyPair = {
  source: (typeof OFFRAMP_SUPPORT)[number]["source"];
  dest: (typeof OFFRAMP_SUPPORT)[number]["dest"];
  providers: RampProviderId[];
};

type ExecuteOnrampInput = {
  provider: RampProviderId;
  destinationWallet: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
  kycReference?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
};

type ExecuteOfframpInput = {
  provider: RampProviderId;
  sourceWallet: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  cryptoAmount: string;
  kycReference?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
};

type ExecuteRampInput =
  | ({ direction: "onramp" } & ExecuteOnrampInput)
  | ({ direction: "offramp" } & ExecuteOfframpInput);

function filterProviders(
  providers: readonly RampProviderId[],
  provider?: RampProviderId
): RampProviderId[] {
  if (provider) {
    return providers.includes(provider) ? [provider] : [];
  }
  return [...providers];
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/**
 * Resolves the product environment for provider credentials.
 * API-key callers are scoped by the key. Dashboard/session callers default to
 * sandbox while that is the only supported dashboard mode.
 */
function resolveSdpEnvironment(c: AppContext): SdpEnvironment {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return apiKey.environment;
  }
  return "sandbox";
}

function rampRuntime(c: AppContext): RampRuntimeContext {
  return {
    env: c.env as unknown as Record<string, string | undefined>,
    mode: resolveSdpEnvironment(c),
  };
}

/** Enriches BVNK compliance with the requester IP from request headers. */
function withRequesterIp(
  c: AppContext,
  compliance?: BvnkComplianceInput
): BvnkComplianceInput | undefined {
  const ipRaw = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for");
  const requesterIpAddress = ipRaw?.split(",")[0]?.trim();
  if (!requesterIpAddress) {
    return compliance;
  }
  return { ...compliance, requesterIpAddress };
}

async function assertRampProviderAvailable(
  c: AppContext,
  providerId: RampProviderId,
  organizationId: string
): Promise<void> {
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    organizationId,
    "ramps",
    providerId,
    resolveSdpEnvironment(c) === "sandbox"
  );
}

async function executeRampWithProvider(
  c: AppContext,
  input: ExecuteRampInput
): Promise<PaymentRampExecution> {
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);
  const ctx = rampRuntime(c);

  if (input.direction === "onramp") {
    const destinationWalletAddress = resolveWalletAddress(
      scope.wallets,
      input.destinationWallet,
      "destinationWallet",
      scope.auth,
      ["payments:write"]
    );
    return await RAMP_PROVIDER_CLIENTS[input.provider].executeOnramp(ctx, {
      destinationWalletAddress,
      cryptoToken: input.cryptoToken,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      kycReference: input.kycReference,
      redirectUrl: input.redirectUrl,
      bvnkCompliance: withRequesterIp(c, input.bvnkCompliance),
    });
  }

  const sourceWallet = scope.wallets.find(
    (wallet) => wallet.walletId === input.sourceWallet || wallet.publicKey === input.sourceWallet
  );
  if (sourceWallet) {
    await assertWalletPolicyAllowsTransfer(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      wallet: sourceWallet,
      enforceDestinationAllowlist: false,
      token: input.cryptoToken,
      amount: input.cryptoAmount,
    });
  }

  // Lightspark off-ramp source is a Grid account id passed through as-is; other
  // providers draw from an SDP wallet whose address we resolve here.
  const sourceWalletAddress =
    input.provider === "lightspark"
      ? input.sourceWallet
      : resolveWalletAddress(scope.wallets, input.sourceWallet, "sourceWallet", scope.auth, [
          "payments:write",
        ]);

  return await RAMP_PROVIDER_CLIENTS[input.provider].executeOfframp(ctx, {
    sourceWalletAddress,
    cryptoToken: input.cryptoToken,
    fiatCurrency: input.fiatCurrency,
    cryptoAmount: input.cryptoAmount,
    kycReference: input.kycReference,
    redirectUrl: input.redirectUrl,
    bvnkCompliance: withRequesterIp(c, input.bvnkCompliance),
  });
}

function readLightsparkData(
  providerData: CounterpartyRow["provider_data"]
): Record<string, unknown> {
  const lightspark = providerData.lightspark;
  return lightspark && typeof lightspark === "object"
    ? (lightspark as Record<string, unknown>)
    : {};
}

function readLightsparkCustomerId(providerData: CounterpartyRow["provider_data"]): string | null {
  const customerId = readLightsparkData(providerData).customerId;
  return typeof customerId === "string" && customerId.length > 0 ? customerId : null;
}

/**
 * Returns the Grid customer id for a counterparty, lazily creating the native
 * Lightspark customer (via the provider) and persisting it into provider_data
 * on first use.
 */
async function ensureLightsparkCustomer(
  c: AppContext,
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string
): Promise<string> {
  const existing = readLightsparkCustomerId(counterparty.provider_data);
  if (existing) {
    return existing;
  }

  const customer = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateCustomer(rampRuntime(c), {
    platformCustomerId: counterparty.id,
    customerType: counterparty.entity_type === "business" ? "BUSINESS" : "INDIVIDUAL",
    fullName: counterparty.display_name,
    email: counterparty.email,
  });

  const existingLightspark = readLightsparkData(counterparty.provider_data);

  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      lightspark: { ...existingLightspark, customerId: customer.id },
    },
  });

  return customer.id;
}

export async function createOnrampQuote(c: AppContext) {
  const body = await c.req.json();
  const parsed = createOnrampQuoteSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const input = parsed.data;
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);

  const projectId = requireProjectId(c);
  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }

  const destinationWalletAddress = resolveWalletAddress(
    scope.wallets,
    input.destinationWallet,
    "destinationWallet",
    scope.auth,
    ["payments:write"]
  );

  switch (input.provider) {
    case "moonpay": {
      const quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        redirectUrl: input.redirectUrl,
      });
      return success(c, { quote });
    }
    case "lightspark": {
      const customerId = await ensureLightsparkCustomer(c, repo, counterparty, projectId);
      const quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        customerId,
        redirectUrl: input.redirectUrl,
      });
      return success(c, { quote });
    }
    default: {
      const exhaustive: never = input.provider;
      throw new AppError(
        "INTERNAL_ERROR",
        `On-ramp quotes are not implemented for provider: ${String(exhaustive)}`
      );
    }
  }
}

export async function createOfframpQuote(c: AppContext) {
  const body = await c.req.json();
  const parsed = createOfframpQuoteSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const input = parsed.data;
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);

  const projectId = requireProjectId(c);
  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }

  if (input.provider === "moonpay") {
    const sourceWalletAddress = resolveWalletAddress(
      scope.wallets,
      input.sourceWallet,
      "sourceWallet",
      scope.auth,
      ["payments:write"]
    );
    const quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOfframpQuote(rampRuntime(c), {
      cryptoToken: input.cryptoToken,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: input.cryptoAmount,
      sourceWalletAddress,
      externalCustomerId: counterparty.external_id ?? counterparty.id,
      redirectUrl: input.redirectUrl,
    });

    return success(c, { quote });
  }

  // Lightspark off-ramp is account-funded and requires a destination fiat payout
  // account created from bank details. That collection step is not wired yet.
  throw new AppError(
    "BAD_REQUEST",
    "Lightspark off-ramp quotes require payout bank details, which aren't collected yet."
  );
}

export async function executeOnramp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOnrampSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const ramp = await executeRampWithProvider(c, { ...parsed.data, direction: "onramp" });
  return success(c, { ramp });
}

export async function executeOfframp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOfframpSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const ramp = await executeRampWithProvider(c, { ...parsed.data, direction: "offramp" });
  return success(c, { ramp });
}

export async function listOnrampCurrencies(c: AppContext) {
  const parsed = listOnrampCurrenciesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid query parameters", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { source, dest, provider } = parsed.data;
  const pairs: OnrampCurrencyPair[] = ONRAMP_SUPPORT.flatMap((row) => {
    if (source && row.source !== source) return [];
    if (dest && row.dest !== dest) return [];
    const providers = filterProviders(row.providers, provider);
    if (providers.length === 0) return [];
    return [{ source: row.source, dest: row.dest, providers }];
  });

  return success(c, {
    currencies: {
      sources: uniqueSorted(pairs.map((row) => row.source)),
      destinations: uniqueSorted(pairs.map((row) => row.dest)),
    },
    pairs,
    supportHash: RAMP_SUPPORT_HASH,
  });
}

export async function listOfframpCurrencies(c: AppContext) {
  const parsed = listOfframpCurrenciesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid query parameters", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { source, dest, provider } = parsed.data;
  const pairs: OfframpCurrencyPair[] = OFFRAMP_SUPPORT.flatMap((row) => {
    if (source && row.source !== source) return [];
    if (dest && row.dest !== dest) return [];
    const providers = filterProviders(row.providers, provider);
    if (providers.length === 0) return [];
    return [{ source: row.source, dest: row.dest, providers }];
  });

  return success(c, {
    currencies: {
      sources: uniqueSorted(pairs.map((row) => row.source)),
      destinations: uniqueSorted(pairs.map((row) => row.dest)),
    },
    pairs,
    supportHash: RAMP_SUPPORT_HASH,
  });
}

export async function simulateSandboxTransfer(c: AppContext) {
  if (resolveSdpEnvironment(c) !== "sandbox") {
    throw new AppError(
      "FORBIDDEN",
      "Sandbox transfer simulation is only available in sandbox mode"
    );
  }

  const body = await c.req.json();
  const parsed = simulateSandboxTransferSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  let transaction: unknown;
  switch (parsed.data.provider) {
    case "lightspark":
      transaction = await RAMP_PROVIDER_CLIENTS.lightspark.sandboxSend(
        rampRuntime(c),
        parsed.data.payload
      );
      break;
  }

  return success(c, { transaction });
}
