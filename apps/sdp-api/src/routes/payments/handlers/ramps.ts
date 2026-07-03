import type {
  BvnkFiatFundingInstruction,
  BvnkPaymentRampInstruction,
  PaymentRampEstimate,
  PaymentRampQuote,
  RampProviderEstimateResult,
} from "@sdp/types";
import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  RAMP_SUPPORT_HASH,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp-support";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import {
  AppError,
  badRequest,
  badRequestQuery,
  conflict,
  counterpartyNotProvisioned,
  internalError,
  notFound,
} from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkPartyDetails,
  bvnkOnboardingRequirements,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkOfframpWallet,
  readBvnkOnrampPaymentRuleState,
} from "@/lib/ramps/providers/bvnk";
import {
  isLightsparkExternalAccountActive,
  latestLightsparkPayoutAccount,
  readLightsparkCustomerId,
} from "@/lib/ramps/providers/lightspark";
import { readyCounterparty } from "@/lib/ramps/requirements";
import type { RampRuntimeContext } from "@/lib/ramps/types";
import { success } from "@/lib/response";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import {
  enforceWalletOperationPolicy,
  walletOperationActorFromAuth,
} from "@/services/policy-enforcement.service";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../context";
import { mapTransferRow } from "../mappers";
import {
  cancelRampTransferSchema,
  createOfframpQuoteSchema,
  createOnrampQuoteSchema,
  estimateOfframpSchema,
  estimateOnrampSchema,
  listOfframpCurrenciesQuerySchema,
  listOnrampCurrenciesQuerySchema,
  simulateSandboxTransferSchema,
  type submitCounterpartyRequirementsSchema,
} from "../schemas";
import { type ResolvedScope, resolveScope, resolveWalletAddress } from "../wallets";
import {
  bvnkOnrampQuote,
  ensureBvnkCustomer,
  ensureBvnkOfframpBeneficiary,
  ensureBvnkOfframpWallet,
  ensureBvnkPaymentRule,
} from "./ramps/bvnk";
import { ensureLightsparkCustomer, ensureLightsparkPayoutAccount } from "./ramps/lightspark";

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

type SubmitCounterpartyRequirementsInput = z.infer<typeof submitCounterpartyRequirementsSchema>;

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

/** Enriches BVNK compliance with the requester IP from request headers. */
export async function assertRampProviderAvailable(
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

type RampPolicyOperationType = "ramp_onramp_quote" | "ramp_offramp_quote";

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
  providerData?: Record<string, unknown>;
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
    throw badRequest(`${fieldName} must reference an SDP wallet.`);
  }
  return wallet;
}

async function enforceRampWalletOperationPolicy(
  c: AppContext,
  input: {
    scope: ResolvedScope;
    wallet: ScopedRampWallet;
    operationType: RampPolicyOperationType;
    provider: RampProviderId;
    counterpartyId: string;
    asset: string;
    amount?: string | null;
    destination?: string | null;
    rawPayload?: Record<string, unknown>;
  }
) {
  return enforceWalletOperationPolicy(c.env, {
    organizationId: input.scope.auth.organizationId,
    projectId: input.scope.auth.projectId,
    custodyWalletId: input.wallet.id,
    walletId: input.wallet.walletId,
    apiKeyId: input.scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(input.scope.auth),
    operationFamily: "ramp",
    operationType: input.operationType,
    asset: input.asset,
    amount: input.amount ?? null,
    destination: input.destination ?? null,
    providerExtensions: { provider: input.provider },
    rawPayload: {
      provider: input.provider,
      counterpartyId: input.counterpartyId,
      ...(input.rawPayload ?? {}),
    },
  });
}

function rampQuoteTransferStatus(quote: PaymentRampQuote): PaymentTransferStatus {
  if (quote.deliveryMode === "manual_instructions" && quote.status === "pending") {
    return "awaiting_payment";
  }
  return quote.status;
}

function isBvnkFiatFundingInstruction(
  instruction: BvnkPaymentRampInstruction
): instruction is BvnkFiatFundingInstruction {
  return instruction.kind === "fiat_funding";
}

function bvnkOnrampTransferProviderData(quote: PaymentRampQuote): Record<string, unknown> {
  if (quote.provider !== "bvnk" || quote.deliveryMode !== "manual_instructions") {
    return {};
  }
  const instruction = quote.paymentInstructions.find(isBvnkFiatFundingInstruction);
  if (!instruction?.ruleId) {
    throw internalError("BVNK on-ramp quote is missing a payment rule id.");
  }
  return {
    bvnk: {
      ruleId: instruction.ruleId,
      ...(instruction.ruleStatus ? { ruleStatus: instruction.ruleStatus } : {}),
      ...(instruction.fundingWalletId ? { fundingWalletId: instruction.fundingWalletId } : {}),
    },
  };
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
  const isOnramp = input.direction === "onramp";
  const created = await repository.createTransfer({
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
    status: rampQuoteTransferStatus(input.quote),
    provider: input.quote.provider,
    providerReference: input.quote.id,
    deliveryMode: input.quote.deliveryMode,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: input.fiatAmount,
    providerData: input.providerData ?? {},
    serializedTx: null,
    signature: null,
    slot: null,
    initiatedByKeyId: apiKey ? apiKey.id : null,
  });

  if (!created) {
    throw new AppError("INTERNAL_ERROR", "Failed to create ramp transfer record");
  }
}

async function createPendingBvnkOfframpTransfer(
  c: AppContext,
  input: {
    scope: ResolvedScope;
    projectId: string;
    counterparty: CounterpartyRow;
    wallet: ScopedRampWallet;
    walletAddress: string;
    cryptoToken: string;
    cryptoAmount: string;
    fiatCurrency: RampFiatCurrency;
  }
): Promise<PaymentTransferRow> {
  const apiKey = c.get("apiKey");
  const repository = getPaymentsRepository(c);
  const created = await repository.createTransfer({
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
    walletId: input.wallet.walletId,
    counterpartyId: input.counterparty.id,
    sourceAddress: input.walletAddress,
    destinationAddress: null,
    token: input.cryptoToken,
    amount: input.cryptoAmount,
    memo: null,
    type: "offramp",
    direction: "outbound",
    status: "pending",
    provider: "bvnk",
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: null,
    providerData: {},
    serializedTx: null,
    signature: null,
    slot: null,
    initiatedByKeyId: apiKey ? apiKey.id : null,
  });

  if (!created) {
    throw new AppError("INTERNAL_ERROR", "Failed to create ramp transfer record");
  }
  return created;
}

async function completePendingBvnkOfframpTransfer(
  c: AppContext,
  input: {
    scope: ResolvedScope;
    projectId: string;
    transferId: string;
    quote: PaymentRampQuote;
  }
): Promise<void> {
  const updated = await getPaymentsRepository(c).updateTransfer({
    transferId: input.transferId,
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
    status: rampQuoteTransferStatus(input.quote),
    providerReference: input.quote.id,
    deliveryMode: input.quote.deliveryMode,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw new AppError("INTERNAL_ERROR", "Failed to complete BVNK off-ramp transfer record");
  }
}

export async function advanceCounterpartyRequirements(
  c: AppContext,
  input: SubmitCounterpartyRequirementsInput & { counterparty: CounterpartyRow; projectId: string }
): Promise<CounterpartyRequirements> {
  switch (input.provider) {
    case "moonpay":
      return readyCounterparty("moonpay", input.direction);
    case "moneygram":
      return readyCounterparty("moneygram", input.direction);
    case "lightspark": {
      const customer = await ensureLightsparkCustomer(c, {
        counterparty: input.counterparty,
        projectId: input.projectId,
      });
      if (input.direction === "offramp") {
        await ensureLightsparkPayoutAccount(c, {
          counterparty: input.counterparty,
          projectId: input.projectId,
          customer,
          fiatCurrency: input.fiatCurrency,
          collectedData: input.collectedData,
        });
      }
      return readyCounterparty("lightspark", input.direction);
    }
    case "bvnk": {
      if (input.direction === "offramp") {
        await ensureBvnkOfframpBeneficiary(c, {
          counterparty: input.counterparty,
          projectId: input.projectId,
          fiatCurrency: input.fiatCurrency,
          collectedData: input.collectedData,
        });
        const refreshed = await getCounterpartiesRepository(c).getCounterpartyById({
          counterpartyId: input.counterparty.id,
          organizationId: input.counterparty.organization_id,
          projectId: input.projectId,
        });
        if (!refreshed) throw notFound("Counterparty");
        const wallet = await ensureBvnkOfframpWallet(
          c,
          rampRuntime(c),
          refreshed,
          input.projectId,
          input.fiatCurrency
        );
        if (!isBvnkWalletActive(wallet.status)) {
          return {
            provider: "bvnk",
            direction: input.direction,
            status: "funding_account_provisioning",
          };
        }
        return readyCounterparty("bvnk", input.direction);
      }
      const customer = await ensureBvnkCustomer(c, input.counterparty, input.projectId, {
        fiatCurrency: input.fiatCurrency,
        collectedData: input.collectedData,
      });
      const scope = await resolveScope(c);
      const destinationWalletAddress = resolveWalletAddress(
        scope.wallets,
        input.destinationWallet,
        "destinationWallet",
        scope.auth
      );
      const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
      const resolution = await ensureBvnkPaymentRule(
        c,
        rampRuntime(c),
        input.counterparty,
        input.projectId,
        customer,
        { currency, network, destinationWalletAddress, fiatCurrency: input.fiatCurrency }
      );
      return bvnkOnboardingRequirements(resolution, input.direction);
    }
    default: {
      const _exhaustive: never = input;
      throw internalError(`Unhandled ramp provider: ${_exhaustive}`);
    }
  }
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
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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

export async function createOnrampQuote(c: AppContext): Promise<Response> {
  const body = await c.req.json();
  const parsed = createOnrampQuoteSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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
  await enforceRampWalletOperationPolicy(c, {
    scope,
    wallet: destinationWallet,
    operationType: "ramp_onramp_quote",
    provider: input.provider,
    counterpartyId: input.counterpartyId,
    asset: input.cryptoToken,
    amount: input.fiatAmount,
    destination: destinationWalletAddress,
    rawPayload: {
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      cryptoToken: input.cryptoToken,
    },
  });

  let quote: PaymentRampQuote;
  let transferProviderData: Record<string, unknown> | undefined;
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
      break;
    }
    case "lightspark": {
      const customerId = readLightsparkCustomerId(counterparty.provider_data);
      if (!customerId) {
        throw counterpartyNotProvisioned("lightspark", "onramp");
      }
      quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        customerId,
        redirectUrl: input.redirectUrl,
      });
      break;
    }
    case "bvnk": {
      quote = await bvnkOnrampQuote(c, {
        counterparty,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        destinationWalletAddress,
      });
      transferProviderData = bvnkOnrampTransferProviderData(quote);
      break;
    }
    case "moneygram":
      throw badRequest("MoneyGram on-ramp is not available.");
    default: {
      const exhaustive: never = input.provider;
      throw new AppError(
        "INTERNAL_ERROR",
        `On-ramp quotes are not implemented for provider: ${String(exhaustive)}`
      );
    }
  }

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
    providerData: transferProviderData,
  });

  return success(c, { quote });
}

export async function createOfframpQuote(c: AppContext): Promise<Response> {
  const body = await c.req.json();
  const parsed = createOfframpQuoteSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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
  await enforceRampWalletOperationPolicy(c, {
    scope,
    wallet: sourceWallet,
    operationType: "ramp_offramp_quote",
    provider: input.provider,
    counterpartyId: input.counterpartyId,
    asset: input.cryptoToken,
    amount: input.cryptoAmount,
    rawPayload: {
      fiatCurrency: input.fiatCurrency,
      cryptoToken: input.cryptoToken,
      cryptoAmount: input.cryptoAmount,
    },
  });

  let quote: PaymentRampQuote;
  let pendingTransfer: PaymentTransferRow | undefined;
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
    case "lightspark": {
      if (!input.fiatCurrency) {
        throw badRequest("fiatCurrency is required for Lightspark off-ramp.");
      }
      const customerId = readLightsparkCustomerId(counterparty.provider_data);
      const payoutAccount = latestLightsparkPayoutAccount(
        counterparty.provider_data,
        input.fiatCurrency
      );
      if (
        !customerId ||
        !payoutAccount ||
        !isLightsparkExternalAccountActive(payoutAccount.status)
      ) {
        throw counterpartyNotProvisioned("lightspark", "offramp");
      }
      quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOfframpQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        sourceWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
        customerId,
        payoutAccountId: payoutAccount.accountId,
      });
      break;
    }
    case "bvnk": {
      if (!input.fiatCurrency) {
        throw badRequest("fiatCurrency is required for BVNK off-ramp.");
      }
      const beneficiary = latestBvnkOfframpBeneficiary(
        counterparty.provider_data,
        input.fiatCurrency
      );
      const wallet = readBvnkOfframpWallet(counterparty.provider_data, input.fiatCurrency);
      if (!beneficiary || !wallet || !isBvnkWalletActive(wallet.status)) {
        throw counterpartyNotProvisioned("bvnk", "offramp");
      }
      pendingTransfer = await createPendingBvnkOfframpTransfer(c, {
        scope,
        projectId,
        counterparty,
        wallet: sourceWallet,
        walletAddress: sourceWalletAddress,
        cryptoToken: input.cryptoToken,
        cryptoAmount: input.cryptoAmount,
        fiatCurrency: input.fiatCurrency,
      });
      try {
        quote = await RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote(rampRuntime(c), {
          cryptoToken: input.cryptoToken,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          paymentTransferId: pendingTransfer.id,
          externalCustomerId: counterparty.external_id ?? counterparty.id,
          bvnkCompliance: buildBvnkPartyDetails(counterparty, "ORIGINATOR"),
          bvnkOfframpWalletId: wallet.id,
        });
      } catch (error) {
        await getPaymentsRepository(c).updateTransfer({
          transferId: pendingTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      break;
    }
    case "moneygram": {
      quote = await RAMP_PROVIDER_CLIENTS.moneygram.createOfframpQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        sourceWalletAddress,
        externalCustomerId: counterparty.external_id ?? counterparty.id,
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

  if (pendingTransfer) {
    await completePendingBvnkOfframpTransfer(c, {
      scope,
      projectId,
      transferId: pendingTransfer.id,
      quote,
    });
  } else {
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
  }

  return success(c, { quote });
}

const CANCELABLE_RAMP_TRANSFER_STATUSES: readonly PaymentTransferStatus[] = [
  "pending",
  "awaiting_payment",
];

export async function cancelRampTransfer(c: AppContext) {
  const body = await c.req.json();
  const parsed = cancelRampTransferSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const input = parsed.data;
  const scope = await resolveScope(c);
  const projectId = requireProjectId(c);
  const repository = getPaymentsRepository(c);

  const transfer = await repository.getTransferByProviderReference({
    provider: input.provider,
    providerReference: input.providerReference,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Transfer");
  }
  if (!CANCELABLE_RAMP_TRANSFER_STATUSES.includes(transfer.status)) {
    throw badRequest(`Transfer can no longer be canceled (status: ${transfer.status}).`);
  }

  const updated = await repository.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: scope.auth.organizationId,
    projectId,
    fromStatuses: CANCELABLE_RAMP_TRANSFER_STATUSES,
    toStatus: "canceled",
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw conflict("Transfer status changed before it could be canceled.");
  }

  return success(c, { transfer: mapTransferRow(updated) });
}

export async function listOnrampCurrencies(c: AppContext) {
  const parsed = listOnrampCurrenciesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({
      errors: z.flattenError(parsed.error).fieldErrors,
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
    throw badRequestQuery({
      errors: z.flattenError(parsed.error).fieldErrors,
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
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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
      const key = buildBvnkOnrampPaymentRuleKey(
        payload.fiatCurrency,
        currency,
        network,
        destinationWalletAddress
      );
      const entry = readBvnkOnrampPaymentRuleState(counterparty.provider_data, key);
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
