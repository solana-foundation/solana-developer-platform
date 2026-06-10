import type {
  BvnkPaymentRampInstruction,
  PaymentRampEstimate,
  PaymentRampExecution,
  PaymentRampQuote,
  RampProviderEstimateResult,
  SdpEnvironment,
} from "@sdp/types";
import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  RAMP_SUPPORT_HASH,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp-support";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { getDb } from "@/db";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import type { PaymentTransferStatus } from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  type BvnkOnrampEntry,
  type BvnkOnrampResolution,
  buildBvnkOnrampInstruction,
  buildBvnkPartyDetails,
  buildBvnkRuleEntity,
  bvnkCustomerExternalReference,
  bvnkOnrampKey,
  bvnkRuleReference,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkCustomer,
  readBvnkData,
  readBvnkOnrampEntry,
  readBvnkWallets,
} from "@/lib/ramps/providers/bvnk";
import type { BvnkComplianceInput, RampRuntimeContext } from "@/lib/ramps/types";
import { buildBvnkIndividualPayload } from "@/lib/ramps/validation/bvnk";
import { success } from "@/lib/response";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import { type AppContext, getPaymentsRepository } from "../context";
import { assertWalletPolicyAllowsTransfer } from "../policy";
import {
  createOfframpQuoteSchema,
  createOnrampQuoteSchema,
  estimateOfframpSchema,
  estimateOnrampSchema,
  executeOfframpSchema,
  executeOnrampSchema,
  listOfframpCurrenciesQuerySchema,
  listOnrampCurrenciesQuerySchema,
  simulateSandboxTransferSchema,
} from "../schemas";
import { type ResolvedScope, resolveScope, resolveWalletAddress } from "../wallets";

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
  counterpartyId?: string;
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
  counterpartyId?: string;
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

type RampQuoteDirection = "onramp" | "offramp";
type ScopedRampWallet = ResolvedScope["wallets"][number];
type BvnkOnrampQuote = PaymentRampQuote & {
  provider: "bvnk";
  deliveryMode: "manual_instructions";
  paymentInstructions: BvnkPaymentRampInstruction[];
};

interface PersistRampQuoteTransferInput {
  scope: ResolvedScope;
  projectId: string;
  counterparty: CounterpartyRow;
  quote: PaymentRampQuote;
  direction: RampQuoteDirection;
  wallet: ScopedRampWallet;
  walletAddress: string;
  cryptoToken: string;
  cryptoAmount: string | null;
  fiatCurrency: RampFiatCurrency | null;
  fiatAmount: string | null;
}

function paymentTransferId(): string {
  return `xfr_${crypto.randomUUID()}`;
}

function requireRampTransferWallet(
  scope: ResolvedScope,
  walletIdOrAddress: string,
  walletAddress: string,
  fieldName: string
): ScopedRampWallet {
  const wallet = scope.wallets.find(
    (entry) => entry.walletId === walletIdOrAddress || entry.publicKey === walletAddress
  );
  if (!wallet) {
    throw new AppError("BAD_REQUEST", `${fieldName} must reference an SDP wallet.`);
  }
  return wallet;
}

function rampQuoteTransferStatus(
  direction: RampQuoteDirection,
  quote: PaymentRampQuote
): PaymentTransferStatus {
  if (
    direction === "onramp" &&
    quote.deliveryMode === "manual_instructions" &&
    quote.status === "pending"
  ) {
    return "awaiting_payment";
  }
  return quote.status;
}

async function persistRampQuoteTransfer(
  c: AppContext,
  input: PersistRampQuoteTransferInput
): Promise<void> {
  const repository = getPaymentsRepository(c);
  const existing = await repository.getTransferByProviderReference({
    provider: input.quote.provider,
    providerReference: input.quote.id,
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
  });
  if (existing) {
    return;
  }

  const apiKey = c.get("apiKey");
  const now = new Date().toISOString();
  const isOnramp = input.direction === "onramp";
  const created = await repository.createTransfer({
    id: paymentTransferId(),
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
    walletId: input.wallet.walletId,
    counterpartyId: input.counterparty.id,
    sourceAddress: isOnramp ? null : input.walletAddress,
    destinationAddress: isOnramp ? input.walletAddress : null,
    token: input.cryptoToken,
    amount: input.cryptoAmount,
    memo: null,
    type: input.direction,
    direction: isOnramp ? "inbound" : "outbound",
    status: rampQuoteTransferStatus(input.direction, input.quote),
    provider: input.quote.provider,
    providerReference: input.quote.id,
    deliveryMode: input.quote.deliveryMode,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: input.fiatAmount,
    providerData: {},
    serializedTx: null,
    initiatedByKeyId: apiKey ? apiKey.id : null,
    createdAt: now,
    updatedAt: now,
  });

  if (!created) {
    throw new AppError("INTERNAL_ERROR", "Failed to create ramp transfer record");
  }
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
    if (input.provider === "bvnk") {
      if (!input.counterpartyId) {
        throw new AppError("BAD_REQUEST", "counterpartyId is required for BVNK on-ramp.");
      }
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
      const { instruction, id, reference } = await resolveBvnkOnramp(
        c,
        repo,
        counterparty,
        projectId,
        {
          cryptoToken: input.cryptoToken,
          fiatCurrency: input.fiatCurrency,
          destinationWalletAddress,
        }
      );
      return {
        id,
        provider: "bvnk",
        status: "pending",
        reference,
        paymentInstructions: [instruction],
      };
    }

    const kycReference = await resolveRampKycReference(
      c,
      scope,
      input.provider,
      input.counterpartyId,
      input.kycReference
    );
    return await RAMP_PROVIDER_CLIENTS[input.provider].executeOnramp(ctx, {
      destinationWalletAddress,
      cryptoToken: input.cryptoToken,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      kycReference,
      redirectUrl: input.redirectUrl,
      bvnkCompliance: input.bvnkCompliance,
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

  const kycReference = await resolveRampKycReference(
    c,
    scope,
    input.provider,
    input.counterpartyId,
    input.kycReference
  );

  return await RAMP_PROVIDER_CLIENTS[input.provider].executeOfframp(ctx, {
    sourceWalletAddress,
    cryptoToken: input.cryptoToken,
    fiatCurrency: input.fiatCurrency,
    cryptoAmount: input.cryptoAmount,
    kycReference,
    redirectUrl: input.redirectUrl,
    bvnkCompliance: input.bvnkCompliance,
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

function requesterIpAddress(c: AppContext): string {
  const forwarded = c.req.header("x-forwarded-for");
  return c.req.header("cf-connecting-ip") ?? forwarded?.split(",")[0]?.trim() ?? "0.0.0.0";
}

async function ensureBvnkOnramp(
  c: AppContext,
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  params: {
    currency: string;
    network: string;
    destinationWalletAddress: string;
    fiatCurrency: string;
    collectedData?: CollectedFieldData;
  }
): Promise<BvnkOnrampResolution> {
  if (counterparty.entity_type === "business") {
    throw new AppError("BAD_REQUEST", "BVNK on-ramp supports individual counterparties only.");
  }
  const countryCode = counterparty.identity.address?.countryCode;
  if (!countryCode) {
    throw new AppError("BAD_REQUEST", "Counterparty address country is required for BVNK on-ramp.");
  }

  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const key = bvnkOnrampKey(
    params.fiatCurrency,
    params.currency,
    params.network,
    params.destinationWalletAddress
  );

  let customer = readBvnkCustomer(counterparty.provider_data);
  let entry: BvnkOnrampEntry = readBvnkOnrampEntry(counterparty.provider_data, key);

  const persist = async () => {
    const latest =
      (await repo.getCounterpartyById({
        counterpartyId: counterparty.id,
        organizationId: counterparty.organization_id,
        projectId,
      })) ?? counterparty;
    const bvnk = readBvnkData(latest.provider_data);
    const wallets = readBvnkWallets(latest.provider_data);
    await repo.updateCounterparty({
      counterpartyId: counterparty.id,
      organizationId: counterparty.organization_id,
      projectId,
      providerData: {
        ...latest.provider_data,
        bvnk: {
          ...bvnk,
          customer: { ...readBvnkCustomer(latest.provider_data), ...customer },
          wallets: { ...wallets, [key]: { ...wallets[key], ...entry } },
        },
      },
    });
  };

  if (!customer.customerReference) {
    const individual = buildBvnkIndividualPayload(
      counterparty,
      params.collectedData,
      params.fiatCurrency
    );
    const session = await client.createAgreementSession(ctx, {
      customerType: "INDIVIDUAL",
      countryCode,
      useCase: "EMBEDDED_FIAT_ACCOUNTS",
    });
    await client.signAgreement(ctx, {
      reference: session.reference,
      ipAddress: requesterIpAddress(c),
    });
    const externalReference =
      customer.externalReference ?? bvnkCustomerExternalReference(counterparty.id);
    const created = await client.createBvnkCustomer(ctx, {
      externalReference,
      signedAgreementSessionReference: session.reference,
      individual,
    });
    customer = {
      externalReference,
      customerReference: created.reference,
      status: created.status,
      verificationStatus: created.verificationStatus,
      verificationUrl: created.verificationUrl,
    };
    await persist();
  }

  if (entry.walletId && entry.bankAccount?.accountNumber && entry.ruleId) {
    return { customer, entry, onboardingStatus: "ready" };
  }

  if (customer.customerReference && !isBvnkCustomerVerified(customer.status)) {
    const latest = await client.getBvnkCustomer(ctx, { reference: customer.customerReference });
    customer = {
      ...customer,
      status: latest.status,
      verificationStatus: latest.verificationStatus,
      verificationUrl: latest.verificationUrl ?? customer.verificationUrl,
    };
    await persist();
  }

  if (!isBvnkCustomerVerified(customer.status) || !customer.customerReference) {
    return {
      customer,
      entry,
      onboardingStatus: customer.verificationUrl ? "verification_required" : "verifying",
    };
  }

  if (!entry.walletId) {
    const walletProfile = await client.getFiatWalletProfile(ctx, {
      customerReference: customer.customerReference,
      currency: params.fiatCurrency,
    });
    const wallet = await client.createFiatWallet(ctx, {
      customerReference: customer.customerReference,
      name: `SDP onramp ${customer.externalReference}`,
      currencyCode: params.fiatCurrency,
      walletProfile,
      idempotencyKey: (await hashString(`bvnk-wallet:${counterparty.id}:${key}`)).slice(0, 36),
    });
    entry = {
      ...entry,
      walletId: wallet.id,
      walletStatus: wallet.status,
      bankAccount: wallet.bankAccount,
    };
    await persist();
  }

  if (entry.walletId && !isBvnkWalletActive(entry.walletStatus)) {
    try {
      const wallet = await client.getFiatWallet(ctx, { walletId: entry.walletId });
      entry = {
        ...entry,
        walletStatus: wallet.status ?? entry.walletStatus,
        bankAccount: wallet.bankAccount ?? entry.bankAccount,
      };
      await persist();
    } catch (error) {
      console.warn(
        `[bvnk onramp] wallet ${entry.walletId} status refresh failed; relying on webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!entry.ruleId && entry.walletId && isBvnkWalletActive(entry.walletStatus)) {
    const rule = await client.createOnrampRule(ctx, {
      reference: await bvnkRuleReference(counterparty.id, key),
      walletId: entry.walletId,
      currency: params.currency,
      network: params.network,
      beneficiaryAddress: params.destinationWalletAddress,
      entity: {
        ...buildBvnkRuleEntity(counterparty),
        customerIdentifier: customer.customerReference,
      },
    });
    entry = { ...entry, ruleId: rule.id ?? entry.ruleId, ruleStatus: rule.status };
    await persist();
  }

  return {
    customer,
    entry,
    onboardingStatus: entry.ruleId && entry.bankAccount?.accountNumber ? "ready" : "provisioning",
  };
}

async function resolveBvnkOnramp(
  c: AppContext,
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  input: {
    cryptoToken: string;
    fiatCurrency?: string;
    destinationWalletAddress: string;
    collectedData?: CollectedFieldData;
  }
) {
  if (!input.fiatCurrency) {
    throw new AppError("BAD_REQUEST", "fiatCurrency is required for BVNK on-ramp.");
  }
  const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
  const fiatCurrency = input.fiatCurrency;
  const resolution = await ensureBvnkOnramp(c, repo, counterparty, projectId, {
    currency,
    network,
    destinationWalletAddress: input.destinationWalletAddress,
    fiatCurrency,
    collectedData: input.collectedData,
  });
  const instruction = buildBvnkOnrampInstruction(resolution, {
    network,
    destinationWalletAddress: input.destinationWalletAddress,
    fiatCurrency,
    mode: resolveSdpEnvironment(c),
  });
  const reference = resolution.entry.ruleId ?? resolution.customer.customerReference;
  if (!reference) {
    throw new AppError("INTERNAL_ERROR", "BVNK on-ramp resolution is missing a reference.");
  }
  return { instruction, id: reference, reference };
}

async function createBvnkOnrampQuote(
  c: AppContext,
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  input: {
    cryptoToken: string;
    fiatCurrency?: string;
    destinationWalletAddress: string;
    collectedData?: CollectedFieldData;
  }
): Promise<BvnkOnrampQuote> {
  const { instruction, id } = await resolveBvnkOnramp(c, repo, counterparty, projectId, input);
  return {
    provider: "bvnk",
    id,
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [instruction],
  };
}

async function resolveRampKycReference(
  c: AppContext,
  scope: Awaited<ReturnType<typeof resolveScope>>,
  provider: RampProviderId,
  counterpartyId: string | undefined,
  fallback: string | undefined
): Promise<string | undefined> {
  if (!counterpartyId || provider !== "lightspark") {
    return fallback;
  }
  const projectId = requireProjectId(c);
  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }
  return ensureLightsparkCustomer(c, repo, counterparty, projectId);
}

async function estimateAcrossProviders(
  c: AppContext,
  providers: readonly RampProviderId[],
  runProvider: (provider: RampProviderId, ctx: RampRuntimeContext) => Promise<PaymentRampEstimate>
): Promise<RampProviderEstimateResult[]> {
  const scope = await resolveScope(c);
  const ctx = rampRuntime(c);

  return Promise.all(
    providers.map(async (provider): Promise<RampProviderEstimateResult> => {
      try {
        await assertRampProviderAvailable(c, provider, scope.auth.organizationId);
        const estimate = await runProvider(provider, ctx);
        return { provider, status: "ok", estimate };
      } catch (error) {
        if (error instanceof AppError && error.code === "ESTIMATE_NOT_AVAILABLE") {
          return { provider, status: "unsupported" };
        }
        return {
          provider,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}

export async function estimateOnramp(c: AppContext) {
  const body = await c.req.json();
  const parsed = estimateOnrampSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const input = parsed.data;
  const row = ONRAMP_SUPPORT.find(
    (pair) => pair.source === input.fiatCurrency && pair.dest === input.assetRail
  );
  const providers = row ? row.providers : [];

  const estimates = await estimateAcrossProviders(c, providers, (provider, ctx) =>
    RAMP_PROVIDER_CLIENTS[provider].estimateOnramp(ctx, {
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
    })
  );

  return success(c, { estimates });
}

export async function estimateOfframp(c: AppContext) {
  const body = await c.req.json();
  const parsed = estimateOfframpSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const input = parsed.data;
  const row = OFFRAMP_SUPPORT.find(
    (pair) => pair.source === input.assetRail && pair.dest === input.fiatCurrency
  );
  const providers = row ? row.providers : [];

  const estimates = await estimateAcrossProviders(c, providers, (provider, ctx) =>
    RAMP_PROVIDER_CLIENTS[provider].estimateOfframp(ctx, {
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: input.cryptoAmount,
    })
  );

  return success(c, { estimates });
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
  const destinationWallet = requireRampTransferWallet(
    scope,
    input.destinationWallet,
    destinationWalletAddress,
    "destinationWallet"
  );

  let quote: PaymentRampQuote;
  let persist: boolean;
  switch (input.provider) {
    case "moonpay": {
      quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        redirectUrl: input.redirectUrl,
      });
      persist = true;
      break;
    }
    case "lightspark": {
      const customerId = await ensureLightsparkCustomer(c, repo, counterparty, projectId);
      quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        customerId,
        redirectUrl: input.redirectUrl,
      });
      persist = true;
      break;
    }
    case "bvnk": {
      const bvnkQuote = await createBvnkOnrampQuote(c, repo, counterparty, projectId, {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        destinationWalletAddress,
        collectedData: input.collectedData,
      });
      const instruction = bvnkQuote.paymentInstructions[0];
      if (!instruction) {
        throw new AppError("INTERNAL_ERROR", "BVNK on-ramp quote is missing instructions.");
      }
      quote = bvnkQuote;
      persist = instruction.onboardingStatus === "ready";
      break;
    }
    default: {
      const exhaustive: never = input.provider;
      throw new AppError(
        "INTERNAL_ERROR",
        `On-ramp quotes are not implemented for provider: ${String(exhaustive)}`
      );
    }
  }

  if (persist) {
    await persistRampQuoteTransfer(c, {
      scope,
      projectId,
      counterparty,
      quote,
      direction: "onramp",
      wallet: destinationWallet,
      walletAddress: destinationWalletAddress,
      cryptoToken: input.cryptoToken,
      cryptoAmount: null,
      fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
      fiatAmount: input.fiatAmount,
    });
  }

  return success(c, { quote });
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

  if (input.provider === "lightspark") {
    // Lightspark off-ramp is account-funded and requires a destination fiat payout
    // account created from bank details. That collection step is not wired yet.
    throw new AppError(
      "BAD_REQUEST",
      "Lightspark off-ramp quotes require payout bank details, which aren't collected yet."
    );
  }

  const sourceWalletAddress = resolveWalletAddress(
    scope.wallets,
    input.sourceWallet,
    "sourceWallet",
    scope.auth,
    ["payments:write"]
  );
  const sourceWallet = requireRampTransferWallet(
    scope,
    input.sourceWallet,
    sourceWalletAddress,
    "sourceWallet"
  );

  let quote: PaymentRampQuote;
  switch (input.provider) {
    case "moonpay": {
      quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOfframpQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        sourceWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        redirectUrl: input.redirectUrl,
      });
      break;
    }
    case "bvnk": {
      quote = await RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        sourceWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        customerId: counterparty.id,
        bvnkCompliance: buildBvnkPartyDetails(counterparty, "BENEFICIARY"),
        redirectUrl: input.redirectUrl,
      });
      break;
    }
    default: {
      const exhaustive: never = input.provider;
      throw new AppError(
        "INTERNAL_ERROR",
        `Off-ramp quotes are not implemented for provider: ${String(exhaustive)}`
      );
    }
  }

  await persistRampQuoteTransfer(c, {
    scope,
    projectId,
    counterparty,
    quote,
    direction: "offramp",
    wallet: sourceWallet,
    walletAddress: sourceWalletAddress,
    cryptoToken: input.cryptoToken,
    cryptoAmount: input.cryptoAmount,
    fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
    fiatAmount: null,
  });

  return success(c, { quote });
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
    case "bvnk": {
      const payload = parsed.data.payload;
      const scope = await resolveScope(c);
      const projectId = requireProjectId(c);
      const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
        counterpartyId: payload.counterpartyId,
        organizationId: scope.auth.organizationId,
        projectId,
      });
      if (!counterparty) {
        throw new AppError("NOT_FOUND", "Counterparty not found");
      }
      const destinationWalletAddress = resolveWalletAddress(
        scope.wallets,
        payload.destinationWallet,
        "destinationWallet",
        scope.auth,
        ["payments:write"]
      );
      const { currency, network } = normalizeBvnkCurrencyAndNetwork(payload.cryptoToken);
      const key = bvnkOnrampKey(payload.fiatCurrency, currency, network, destinationWalletAddress);
      const entry = readBvnkOnrampEntry(counterparty.provider_data, key);
      if (!entry.walletId) {
        throw new AppError(
          "BAD_REQUEST",
          "BVNK funding wallet is not provisioned yet for this destination."
        );
      }
      if (!isBvnkWalletActive(entry.walletStatus)) {
        throw new AppError(
          "BAD_REQUEST",
          "BVNK funding wallet is not active for this destination."
        );
      }
      transaction = await RAMP_PROVIDER_CLIENTS.bvnk.simulatePayin(rampRuntime(c), {
        walletId: entry.walletId,
        amount: payload.amount,
        currency: payload.fiatCurrency,
        originatorName: counterparty.display_name,
        remittanceInformation: entry.bankAccount?.paymentReference,
      });
      break;
    }
  }

  return success(c, { transaction });
}
