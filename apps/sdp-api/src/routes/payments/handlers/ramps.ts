import type {
  PaymentRampEstimate,
  PaymentRampExecution,
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
import type { PaymentTransferStatus } from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import { AppError, badRequest, badRequestQuery, internalError, notFound } from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  buildBvnkPartyDetails,
  bvnkOnboardingRequirements,
  bvnkOnrampKey,
  isBvnkWalletActive,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkOnrampEntry,
} from "@/lib/ramps/providers/bvnk";
import { readyCounterparty } from "@/lib/ramps/requirements";
import type { RampRuntimeContext } from "@/lib/ramps/types";
import { success } from "@/lib/response";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../context";
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
  type submitCounterpartyRequirementsSchema,
} from "../schemas";
import { type ResolvedScope, resolveScope, resolveWalletAddress } from "../wallets";
import { bvnkOnrampQuote, ensureBvnkCustomer, ensureBvnkPaymentRule } from "./ramps/bvnk";
import { ensureLightsparkCustomer, lightsparkOfframpQuote } from "./ramps/lightspark";

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

type ExecuteOnrampInput = z.infer<typeof executeOnrampSchema>;

type ExecuteOfframpInput = z.infer<typeof executeOfframpSchema>;

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
    throw badRequest(`${fieldName} must reference an SDP wallet.`);
  }
  return wallet;
}

function rampQuoteTransferStatus(quote: PaymentRampQuote): PaymentTransferStatus {
  if (quote.deliveryMode === "manual_instructions" && quote.status === "pending") {
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
    status: rampQuoteTransferStatus(input.quote),
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

async function executeOnrampWithProvider(
  c: AppContext,
  input: ExecuteOnrampInput
): Promise<PaymentRampExecution> {
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);
  const ctx = rampRuntime(c);

  const destinationWalletAddress = resolveWalletAddress(
    scope.wallets,
    input.destinationWallet,
    "destinationWallet",
    scope.auth,
    ["payments:write"]
  );

  const projectId = requireProjectId(c);
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) throw notFound("Counterparty");

  switch (input.provider) {
    case "moonpay":
      return await RAMP_PROVIDER_CLIENTS.moonpay.executeOnramp(ctx, {
        destinationWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        redirectUrl: input.redirectUrl,
      });
    case "lightspark": {
      const providerCustomer = await ensureLightsparkCustomer(c, { counterparty, projectId });
      return await RAMP_PROVIDER_CLIENTS.lightspark.executeOnramp(ctx, {
        destinationWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        providerCustomer,
      });
    }
    case "bvnk": {
      if (!input.fiatCurrency) throw badRequest("fiatCurrency is required for BVNK on-ramp.");
      const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
      const customer = await ensureBvnkCustomer(c, counterparty, projectId, {
        fiatCurrency: input.fiatCurrency,
      });
      const bvnkPaymentRule = await ensureBvnkPaymentRule(
        c,
        ctx,
        counterparty,
        projectId,
        customer,
        {
          currency,
          network,
          destinationWalletAddress,
          fiatCurrency: input.fiatCurrency,
        }
      );
      return await RAMP_PROVIDER_CLIENTS.bvnk.executeOnramp(ctx, {
        destinationWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        bvnkPaymentRule,
      });
    }
    default: {
      const _exhaustive: never = input.provider;
      throw internalError(`Unhandled ramp provider: ${_exhaustive}`);
    }
  }
}

export async function advanceCounterpartyRequirements(
  c: AppContext,
  input: SubmitCounterpartyRequirementsInput & { counterparty: CounterpartyRow; projectId: string }
): Promise<CounterpartyRequirements> {
  switch (input.provider) {
    case "moonpay":
      return readyCounterparty("moonpay", input.direction);
    case "lightspark": {
      await ensureLightsparkCustomer(c, {
        counterparty: input.counterparty,
        projectId: input.projectId,
      });
      return readyCounterparty("lightspark", input.direction);
    }
    case "bvnk": {
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

async function executeOfframpWithProvider(
  c: AppContext,
  input: ExecuteOfframpInput
): Promise<PaymentRampExecution> {
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);
  const ctx = rampRuntime(c);

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

  const projectId = requireProjectId(c);
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) throw notFound("Counterparty");

  switch (input.provider) {
    case "moonpay":
      return await RAMP_PROVIDER_CLIENTS.moonpay.executeOfframp(ctx, {
        sourceWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        redirectUrl: input.redirectUrl,
      });
    case "lightspark": {
      const providerCustomer = await ensureLightsparkCustomer(c, { counterparty, projectId });
      return await RAMP_PROVIDER_CLIENTS.lightspark.executeOfframp(ctx, {
        sourceWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        providerCustomer,
      });
    }
    case "bvnk": {
      if (!input.fiatCurrency) throw badRequest("fiatCurrency is required for BVNK off-ramp.");
      const providerCustomer = await ensureBvnkCustomer(c, counterparty, projectId, {
        fiatCurrency: input.fiatCurrency,
      });
      return await RAMP_PROVIDER_CLIENTS.bvnk.executeOfframp(ctx, {
        sourceWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        providerCustomer,
        bvnkCompliance: input.bvnkCompliance,
      });
    }
    default: {
      const _exhaustive: never = input.provider;
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

export async function createOnrampQuote(c: AppContext) {
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
      const { customerId } = await ensureLightsparkCustomer(c, { counterparty, projectId });
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
      ({ quote, persist } = await bvnkOnrampQuote(c, {
        counterparty,
        projectId,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        destinationWalletAddress,
        collectedData: input.collectedData,
      }));
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
    case "lightspark": {
      quote = await lightsparkOfframpQuote(c, {
        counterparty,
        projectId,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        sourceWalletAddress,
        collectedData: input.collectedData,
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
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const ramp = await executeOnrampWithProvider(c, parsed.data);
  return success(c, { ramp });
}

export async function executeOfframp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOfframpSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const ramp = await executeOfframpWithProvider(c, parsed.data);
  return success(c, { ramp });
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
