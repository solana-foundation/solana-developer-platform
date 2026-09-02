import { redactCredentialString } from "@sdp/custody";
import { SdpPaymentsError } from "@sdp/payments";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkPartyDetails,
  bvnkOnboardingRequirements,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkOfframpWallet,
  readBvnkOnrampPaymentRuleState,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  lightsparkCollectAccountRequirements,
  lightsparkPurposeOfPaymentRequirement,
} from "@sdp/payments/ramps/providers/lightspark/counterparty";
import {
  isLightsparkExternalAccountActive,
  readLightsparkPaymentRail,
  readLightsparkPurposeOfPayment,
} from "@sdp/payments/ramps/providers/lightspark/provider-data";
import { readMuralOrganization } from "@sdp/payments/ramps/providers/mural/provider-data";
import { readyCounterparty } from "@sdp/payments/ramps/requirements";
import { isSolanaCryptoAsset, SOLANA_ASSET_TO_RAIL } from "@sdp/payments/ramps/shared";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  isCountryCode,
  type PaymentRampEstimate,
  type PaymentRampInstruction,
  type PaymentRampQuote,
  type RampProviderEstimateResult,
  type SdpEnvironment,
} from "@sdp/types";
import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  RAMP_PROVIDER_SUPPORT_DETAILS,
  RAMP_SUPPORT_HASH,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp";
import type {
  CryptoRailId,
  OfframpPairSupport,
  OnrampPairSupport,
  RampProviderDirectionSupport,
} from "@sdp/types/payment-rails";
import { isRampProviderSurfaced, type RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPostgresCounterpartyProviderAccountsRepository,
  isRampTransferType,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import {
  generatePaymentTransferId,
  type PaymentTransferRow,
  type PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  badRequest,
  badRequestQuery,
  conflict,
  counterpartyNotProvisioned,
  internalError,
  notFound,
  redactErrorForCapture,
  unsupportedRampCorridor,
} from "@/lib/errors";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { isSentryEnabled } from "@/runtime/observability";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import { mapPayoutRequirementAccounts } from "@/services/payments/payout-requirement-accounts";
import { enrichCounterpartyProviderAccounts } from "@/services/payments/provider-account-enrichment";
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  assertProviderAvailable,
  assertRampProviderSurfaced,
} from "@/services/provider-availability.service";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../context";
import { mapTransferRow } from "../mappers";
import {
  type cancelRampTransferSchema,
  type createOfframpQuoteSchema,
  type createOnrampQuoteSchema,
  type estimateOfframpSchema,
  type estimateOnrampSchema,
  listOfframpCurrenciesQuerySchema,
  listOnrampCurrenciesQuerySchema,
  type simulateSandboxTransferSchema,
  type submitCounterpartyRequirementsSchema,
} from "../schemas";
import {
  assertFreshPaymentWalletAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletAddress,
} from "../wallets";
import {
  bvnkOnrampQuote,
  completePendingBvnkOfframpTransfer,
  createPendingBvnkOfframpTransfer,
  ensureBvnkCustomer,
  ensureBvnkOfframpBeneficiary,
  ensureBvnkOfframpWallet,
  ensureBvnkPaymentRule,
} from "./ramps/bvnk";
import {
  ensureLightsparkCustomer,
  ensureLightsparkPayoutAccount,
  ensureLightsparkPurposeOfPayment,
  lightsparkProviderCustomerId,
  selectLightsparkPayoutAccount,
} from "./ramps/lightspark";
import {
  muralOnrampQuote,
  resolveMuralOnrampAccount,
  resolveMuralRequirements,
} from "./ramps/mural";
import {
  assertRampQuoteBindingMatches,
  isRampQuoteBindingExpired,
  type RampQuoteBinding,
  rampQuoteExpiryProviderData,
} from "./ramps/quote-binding";
import { stripeOnrampQuote } from "./ramps/stripe";

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

type ScopedSubmitCounterpartyRequirementsInput = SubmitCounterpartyRequirementsInput & {
  counterparty: CounterpartyRow;
  projectId: string;
};

type ScopedLightsparkRequirementsInput = Extract<
  ScopedSubmitCounterpartyRequirementsInput,
  { provider: "lightspark" }
>;

function filterProviders(
  providers: readonly RampProviderId[],
  environment: SdpEnvironment,
  provider?: RampProviderId
): RampProviderId[] {
  const surfaced = providers.filter((p) => isRampProviderSurfaced(p, environment));
  if (provider) {
    return surfaced.includes(provider) ? [provider] : [];
  }
  return surfaced;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function buildProviderDetails(
  providerIds: readonly RampProviderId[],
  direction: "onramp" | "offramp"
): Partial<Record<RampProviderId, RampProviderDirectionSupport>> {
  const providerDetails: Partial<Record<RampProviderId, RampProviderDirectionSupport>> = {};
  for (const providerId of providerIds) {
    providerDetails[providerId] = RAMP_PROVIDER_SUPPORT_DETAILS[providerId][direction];
  }
  return providerDetails;
}

function providersFromPairs(
  pairs: readonly { providers: readonly RampProviderId[] }[]
): RampProviderId[] {
  return uniqueSorted(pairs.flatMap((row) => row.providers));
}

/** Throws unless the org has the ramp provider enabled for the request's environment. */
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

/**
 * Resolves a request's crypto asset symbol to its canonical crypto rail.
 *
 * @param cryptoToken - Public crypto asset symbol from the request.
 * @returns The canonical Solana crypto rail.
 */
export function requireCryptoRail(cryptoToken: string): CryptoRailId {
  const symbol = cryptoToken.trim().toUpperCase();
  if (!isSolanaCryptoAsset(symbol)) {
    throw badRequest(
      `cryptoToken must be one of: ${Object.keys(SOLANA_ASSET_TO_RAIL).join(", ")}.`
    );
  }
  return SOLANA_ASSET_TO_RAIL[symbol];
}

/**
 * Throws unless the committed corridor-support matrix (the same tables estimate
 * selects providers from) lists the provider for the requested crypto/fiat pair.
 * When fiatCurrency is omitted (off-ramp quotes may defer fiat selection to the
 * provider), the provider must support the crypto rail for at least one fiat.
 */
function assertRampCorridorSupported(
  direction: RampQuoteDirection,
  input: { provider: RampProviderId; cryptoToken: string; fiatCurrency?: RampFiatCurrency },
  environment: SdpEnvironment
): void {
  const rail = requireCryptoRail(input.cryptoToken);
  const pairs: readonly (OnrampPairSupport | OfframpPairSupport)[] =
    direction === "onramp" ? ONRAMP_SUPPORT : OFFRAMP_SUPPORT;
  const fiat = input.fiatCurrency;
  const matched = pairs.filter((pair) => {
    const railSide = direction === "onramp" ? pair.dest : pair.source;
    const fiatSide = direction === "onramp" ? pair.source : pair.dest;
    return railSide === rail && (fiat === undefined || fiatSide === fiat);
  });
  const supportedProviders = providersFromPairs(matched).filter((p) =>
    isRampProviderSurfaced(p, environment)
  );
  if (!supportedProviders.includes(input.provider)) {
    throw unsupportedRampCorridor(input.provider, direction, {
      assetRail: rail,
      fiatCurrency: fiat,
      supportedProviders,
    });
  }
}
type ScopedRampWallet = ResolvedScope["wallets"][number];

type CreateOnrampQuoteBody = z.output<typeof createOnrampQuoteSchema>;

type CreateOfframpQuoteBody = z.output<typeof createOfframpQuoteSchema>;

interface RampQuotePolicyResolved {
  scope: ResolvedScope;
  projectId: string;
  counterparty: CounterpartyRow;
  wallet: ScopedRampWallet;
  walletAddress: string;
}

interface PersistRampQuoteTransferInput {
  transferId: string;
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
  rampsMemo: Record<string, string> | undefined;
  providerData?: Record<string, unknown>;
}

function requireRampTransferWallet(
  scope: ResolvedScope,
  walletIdOrAddress: string,
  walletAddress: string,
  fieldName: string
): ScopedRampWallet {
  const matches = scope.wallets.filter(
    (entry) => entry.walletId === walletIdOrAddress || entry.publicKey === walletAddress
  );
  if (matches.length > 1) {
    throw conflict("Custody wallet ownership is ambiguous");
  }
  const wallet = matches[0];
  if (!wallet) {
    throw badRequest(`${fieldName} must reference an SDP wallet.`);
  }
  return wallet;
}

/**
 * Resolve the state shared by both ramp-quote extractions: corridor support,
 * provider availability, the counterparty, and the SDP wallet on the crypto
 * leg.
 *
 * @param c - Request context.
 * @param direction - The quote direction.
 * @param input - The validated quote request body.
 * @param walletFieldName - The request field naming the wallet.
 * @param walletIdOrAddress - The requested wallet id or address.
 * @returns The resolved scope, project, counterparty, wallet, and address.
 */
async function resolveRampQuoteRequest(
  c: AppContext,
  direction: RampQuoteDirection,
  input: CreateOnrampQuoteBody | CreateOfframpQuoteBody,
  walletFieldName: "destinationWallet" | "sourceWallet",
  walletIdOrAddress: string
): Promise<RampQuotePolicyResolved> {
  assertRampProviderSurfaced(input.provider, resolveSdpEnvironment(c));
  assertRampCorridorSupported(direction, input, resolveSdpEnvironment(c));
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);

  const projectId = requireProjectId(c);
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }

  const walletAddress = resolveWalletAddress(
    scope.wallets,
    walletIdOrAddress,
    walletFieldName,
    scope.auth,
    ["payments:write"]
  );
  const wallet = requireRampTransferWallet(
    scope,
    walletIdOrAddress,
    walletAddress,
    walletFieldName
  );
  await assertFreshPaymentWalletAccess(c, wallet, ["payments:write"]);
  return { scope, projectId, counterparty, wallet, walletAddress };
}

/**
 * Parse and resolve an on-ramp quote into its wallet-operation policy candidate.
 *
 * @param c - Request context.
 * @returns The candidate, validated body, resolved resources, and raw payload.
 */
export async function extractOnrampQuotePolicyCandidate(
  c: ValidatedBodyContext<typeof createOnrampQuoteSchema>
): Promise<PolicyGateExtraction> {
  const input = c.req.valid("json");
  const { scope, projectId, counterparty, wallet, walletAddress } = await resolveRampQuoteRequest(
    c,
    "onramp",
    input,
    "destinationWallet",
    input.destinationWallet
  );

  return {
    candidate: {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      custodyWalletId: wallet.id,
      walletId: wallet.walletId,
      apiKeyId: scope.auth.apiKeyId,
      actor: walletOperationActorFromAuth(scope.auth),
      source: "api",
      operationFamily: "ramp",
      operationType: "ramp_onramp_quote",
      asset: input.cryptoToken,
      amount: input.fiatAmount,
      destination: walletAddress,
      context: {},
      providerExtensions: { provider: input.provider },
    },
    legs: [],
    body: input,
    resolved: { scope, projectId, counterparty, wallet, walletAddress },
    rawPayload: {
      provider: input.provider,
      counterpartyId: input.counterpartyId,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      cryptoToken: input.cryptoToken,
    },
    idempotencyKey: null,
  };
}

/**
 * Parse and resolve an off-ramp quote into its wallet-operation policy candidate.
 *
 * @param c - Request context.
 * @returns The candidate, validated body, resolved resources, and raw payload.
 */
export async function extractOfframpQuotePolicyCandidate(
  c: ValidatedBodyContext<typeof createOfframpQuoteSchema>
): Promise<PolicyGateExtraction> {
  const input = c.req.valid("json");
  const { scope, projectId, counterparty, wallet, walletAddress } = await resolveRampQuoteRequest(
    c,
    "offramp",
    input,
    "sourceWallet",
    input.sourceWallet
  );

  return {
    candidate: {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      custodyWalletId: wallet.id,
      walletId: wallet.walletId,
      apiKeyId: scope.auth.apiKeyId,
      actor: walletOperationActorFromAuth(scope.auth),
      source: "api",
      operationFamily: "ramp",
      operationType: "ramp_offramp_quote",
      asset: input.cryptoToken,
      amount: input.cryptoAmount,
      destination: null,
      context: {},
      providerExtensions: { provider: input.provider },
    },
    legs: [],
    body: input,
    resolved: { scope, projectId, counterparty, wallet, walletAddress },
    rawPayload: {
      provider: input.provider,
      counterpartyId: input.counterpartyId,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: input.cryptoAmount,
      cryptoToken: input.cryptoToken,
    },
    idempotencyKey: null,
  };
}

function rampQuoteTransferStatus(quote: PaymentRampQuote): PaymentTransferStatus {
  if (quote.deliveryMode === "manual_instructions" && quote.status === "pending") {
    return "awaiting_payment";
  }
  return quote.status;
}

function isCryptoDepositInstruction(
  instruction: PaymentRampInstruction
): instruction is Extract<PaymentRampInstruction, { kind: "crypto_deposit" }> {
  return "kind" in instruction && instruction.kind === "crypto_deposit";
}

/**
 * Persists the quote's crypto deposit instruction alongside the transfer so
 * the in-app send validates against it — the same contract hosted providers
 * fill via their awaiting_payment webhook.
 *
 * @param input - Quote persistence input.
 * @returns providerData fragment carrying the cryptoDeposit, or empty when
 * the quote has no crypto deposit instruction.
 */
function rampQuoteCryptoDepositProviderData(
  input: PersistRampQuoteTransferInput
): Record<string, unknown> {
  if (input.direction !== "offramp" || input.quote.deliveryMode !== "manual_instructions") {
    return {};
  }
  const instruction = input.quote.paymentInstructions?.find(isCryptoDepositInstruction);
  if (instruction === undefined || input.cryptoAmount === null) {
    return {};
  }
  return {
    cryptoDeposit: {
      destinationAddress: instruction.destinationAddress,
      amount: input.cryptoAmount,
    },
  };
}

async function persistRampQuoteTransfer(
  c: AppContext,
  input: PersistRampQuoteTransferInput
): Promise<string> {
  const repository = getPaymentsRepository(c);
  const isOnramp = input.direction === "onramp";
  const binding: RampQuoteBinding = {
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.wallet.id,
    walletId: input.wallet.walletId,
    counterpartyId: input.counterparty.id,
    direction: input.direction,
    token: rampTransferTokenMint(input.cryptoToken, c.env),
    sourceAddress: isOnramp ? null : input.walletAddress,
    destinationAddress: isOnramp ? input.walletAddress : null,
    amount: input.cryptoAmount,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: input.fiatAmount,
  };

  const existing = await repository.getTransferByProviderReference({
    provider: input.quote.provider,
    providerReference: input.quote.id,
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
  });
  if (existing) {
    // Idempotent replay only: the same reference with any changed input, or a
    // reference whose bound session/quote already expired, fails closed.
    assertRampQuoteBindingMatches(existing, binding);
    if (isRampQuoteBindingExpired(existing)) {
      throw conflict("Provider quote/session reference has expired; create a new quote.");
    }
    return existing.id;
  }

  const apiKey = c.get("apiKey");
  let created: PaymentTransferRow | null;
  try {
    created = await repository.createTransfer({
      id: input.transferId,
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      custodyWalletId: binding.custodyWalletId,
      walletId: binding.walletId,
      counterpartyId: binding.counterpartyId,
      sourceAddress: binding.sourceAddress,
      destinationAddress: binding.destinationAddress,
      token: binding.token,
      amount: binding.amount,
      memo: null,
      type: input.direction,
      direction: isOnramp ? "inbound" : "outbound",
      status: rampQuoteTransferStatus(input.quote),
      provider: input.quote.provider,
      providerReference: input.quote.id,
      deliveryMode: input.quote.deliveryMode,
      fiatCurrency: binding.fiatCurrency,
      fiatAmount: binding.fiatAmount,
      rampsMemo: input.rampsMemo,
      providerData: {
        ...(input.providerData ?? {}),
        ...rampQuoteExpiryProviderData(input.quote),
        ...rampQuoteCryptoDepositProviderData(input),
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: apiKey ? apiKey.id : null,
    });
  } catch (error) {
    // The (provider, provider_reference) unique index spans all tenants: a
    // reference already bound outside this tenant's scope surfaces here.
    if (isPostgresUniqueViolation(error)) {
      throw conflict(
        "Provider quote/session reference is already bound to a different ramp transfer."
      );
    }
    throw error;
  }

  if (!created) {
    throw new AppError("INTERNAL_ERROR", "Failed to create ramp transfer record");
  }
  return created.id;
}

/**
 * Advances a Lightspark customer through purpose and payout-account setup.
 *
 * @param c - Request context for database and provider access.
 * @param input - Scoped Lightspark requirements submission.
 * @returns The resulting Lightspark requirements state.
 */
async function advanceLightsparkRequirements(
  c: AppContext,
  input: ScopedLightsparkRequirementsInput
): Promise<CounterpartyRequirements> {
  const [customer, purposeOfPayment] = await Promise.all([
    ensureLightsparkCustomer(c, {
      counterparty: input.counterparty,
      projectId: input.projectId,
      collectedData: input.collectedData,
    }),
    ensureLightsparkPurposeOfPayment(c, {
      counterparty: input.counterparty,
      projectId: input.projectId,
      collectedData: input.collectedData,
    }),
  ]);
  if (purposeOfPayment === null) {
    return lightsparkPurposeOfPaymentRequirement(input.direction);
  }
  if (input.direction === "onramp") {
    return readyCounterparty("lightspark", input.direction);
  }
  const cryptoRail = requireCryptoRail(input.cryptoToken);
  const collectedData = input.collectedData;
  const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  if (collectedData === undefined || collectedData.destinationCountry === undefined) {
    const rows = await repository.listExternalAccounts({
      organizationId: input.counterparty.organization_id,
      projectId: input.projectId,
      counterpartyId: input.counterparty.id,
      provider: "lightspark",
      fiatCurrency: input.fiatCurrency,
    });
    const enriched = await enrichCounterpartyProviderAccounts(rampRuntime(c), rows);
    return lightsparkCollectAccountRequirements(
      cryptoRail,
      input.fiatCurrency,
      mapPayoutRequirementAccounts(rows, enriched)
    );
  }
  if (!isCountryCode(collectedData.destinationCountry)) {
    throw badRequest("destinationCountry must be a supported ISO 3166-1 alpha-2 country code.");
  }
  const accounts = await repository.listActiveExternalAccounts({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "lightspark",
    fiatCurrency: input.fiatCurrency,
    destinationCountry: collectedData.destinationCountry,
  });
  const existing = selectLightsparkPayoutAccount(
    accounts,
    collectedData.paymentRails,
    input.fiatCurrency,
    collectedData.destinationCountry
  );
  if (existing !== null && existing.external_account_reference !== null) {
    if (existing.provider_status === null) {
      throw badRequest("Lightspark payout account has no provider status yet.");
    }
    if (
      isLightsparkExternalAccountActive(existing.provider_status) &&
      existing.payment_rail !== null
    ) {
      return readyCounterparty("lightspark", input.direction);
    }
    const refreshed = await RAMP_PROVIDER_CLIENTS.lightspark.getExternalAccount(rampRuntime(c), {
      accountId: existing.external_account_reference,
    });
    const paymentRail =
      existing.payment_rail === null ? readLightsparkPaymentRail(refreshed) : undefined;
    if (refreshed.status !== existing.provider_status || paymentRail !== undefined) {
      await repository.updateExternalAccountStatus({
        organizationId: input.counterparty.organization_id,
        projectId: input.projectId,
        counterpartyId: input.counterparty.id,
        provider: "lightspark",
        id: existing.id,
        providerStatus: refreshed.status,
        paymentRail,
      });
    }
    if (isLightsparkExternalAccountActive(refreshed.status)) {
      return readyCounterparty("lightspark", input.direction);
    }
    throw badRequest(
      `Lightspark payout account is not active yet (status: ${refreshed.status}). Retry once it is verified.`
    );
  }
  if (collectedData.paymentRails === undefined) {
    throw badRequest('Missing required field "paymentRails" for Lightspark off-ramp.');
  }
  const account = await ensureLightsparkPayoutAccount(c, {
    counterparty: input.counterparty,
    projectId: input.projectId,
    customer,
    cryptoRail,
    fiatCurrency: input.fiatCurrency,
    collectedData,
  });
  if (account.provider_status === null) {
    throw badRequest("Lightspark payout account has no provider status yet.");
  }
  if (isLightsparkExternalAccountActive(account.provider_status)) {
    return readyCounterparty("lightspark", input.direction);
  }
  throw badRequest(
    `Lightspark payout account was created but is not active yet (status: ${account.provider_status}). Retry once it is verified.`
  );
}

export async function advanceCounterpartyRequirements(
  c: AppContext,
  input: ScopedSubmitCounterpartyRequirementsInput
): Promise<CounterpartyRequirements> {
  switch (input.provider) {
    case "moonpay":
      return readyCounterparty("moonpay", input.direction);
    case "moneygram":
      return readyCounterparty("moneygram", input.direction);
    case "lightspark":
      return advanceLightsparkRequirements(c, input);
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
      const customer = await ensureBvnkCustomer(c, input.counterparty, input.projectId);
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
    case "mural":
      return resolveMuralRequirements(c, input.counterparty, input.projectId, input.direction);
    case "coinbase":
      return readyCounterparty("coinbase", input.direction);
    case "stripe":
      return readyCounterparty("stripe", input.direction);
    default: {
      const _exhaustive: never = input;
      throw internalError(`Unhandled ramp provider: ${_exhaustive}`);
    }
  }
}

/** Ceiling on simultaneous live provider estimate calls per request. */
export const RAMP_ESTIMATE_PROVIDER_CONCURRENCY = 3;

export async function estimateAcrossProviders(
  c: AppContext,
  providers: readonly RampProviderId[],
  runProvider: (provider: RampProviderId, ctx: RampRuntimeContext) => Promise<PaymentRampEstimate>
): Promise<RampProviderEstimateResult[]> {
  const scope = await resolveScope(c);
  const ctx = rampRuntime(c);

  const settled = await mapSettledWithConcurrency(
    [...providers],
    RAMP_ESTIMATE_PROVIDER_CONCURRENCY,
    async (provider): Promise<RampProviderEstimateResult> => {
      try {
        await assertRampProviderAvailable(c, provider, scope.auth.organizationId);
        const estimate = await runProvider(provider, ctx);
        return { provider, status: "ok", estimate };
      } catch (error) {
        if (error instanceof SdpPaymentsError && error.code === "ESTIMATE_NOT_AVAILABLE") {
          return { provider, status: "unsupported" };
        }
        const cause = error instanceof Error ? error : new Error(String(error));
        logEvent("error", {
          event: "sdp_api_ramp_provider_error",
          provider,
          organization_id: scope.auth.organizationId,
          error_message: redactCredentialString(cause.message),
          ...describeError(error),
        });
        const observability = c.get("observability");
        if (observability && isSentryEnabled(c.env)) {
          try {
            observability.withScope((sentryScope) => {
              sentryScope.setTag("provider", provider);
              sentryScope.setTag("organization_id", scope.auth.organizationId);
              observability.captureException(redactErrorForCapture(cause));
            });
          } catch {
            // never let telemetry change the per-provider error contract
          }
        }
        return {
          provider,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  // The mapper catches internally, so every result is fulfilled.
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

export async function estimateOnramp(c: ValidatedBodyContext<typeof estimateOnrampSchema>) {
  const input = c.req.valid("json");
  const row = ONRAMP_SUPPORT.find(
    (pair) => pair.source === input.fiatCurrency && pair.dest === input.assetRail
  );
  const providers = row ? filterProviders(row.providers, resolveSdpEnvironment(c)) : [];

  const estimates = await estimateAcrossProviders(c, providers, (provider, ctx) =>
    RAMP_PROVIDER_CLIENTS[provider].estimateOnramp(ctx, {
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
    })
  );

  return success(c, { estimates });
}

export async function estimateOfframp(c: ValidatedBodyContext<typeof estimateOfframpSchema>) {
  const input = c.req.valid("json");
  const row = OFFRAMP_SUPPORT.find(
    (pair) => pair.source === input.assetRail && pair.dest === input.fiatCurrency
  );
  const providers = row ? filterProviders(row.providers, resolveSdpEnvironment(c)) : [];

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
  const {
    body: input,
    resolved: {
      scope,
      projectId,
      counterparty,
      wallet: destinationWallet,
      walletAddress: destinationWalletAddress,
    },
  } = getPolicyGateContext<CreateOnrampQuoteBody, RampQuotePolicyResolved>(c);

  await beginApprovedWalletOperationEffect(c);

  // Requirements/policy have succeeded. Reserve the ID now so the provider
  // quote and the eventual ledger row share the same internal transfer ID.
  const reservedTransferId = generatePaymentTransferId();
  let quote: PaymentRampQuote;
  let precreatedTransferId: string | undefined;
  let transferProviderData: Record<string, unknown> | undefined;
  switch (input.provider) {
    case "moonpay": {
      const apiKey = c.get("apiKey");
      const pendingTransfer = await getPaymentsRepository(c).createTransfer({
        id: reservedTransferId,
        organizationId: scope.auth.organizationId,
        projectId,
        custodyWalletId: destinationWallet.id,
        walletId: destinationWallet.walletId,
        counterpartyId: counterparty.id,
        sourceAddress: null,
        destinationAddress: destinationWalletAddress,
        token: rampTransferTokenMint(input.cryptoToken, c.env),
        amount: null,
        memo: null,
        type: "onramp",
        direction: "inbound",
        status: "pending",
        provider: "moonpay",
        providerReference: null,
        deliveryMode: null,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        rampsMemo: input.rampsMemo,
        providerData: {},
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: apiKey ? apiKey.id : null,
      });
      if (!pendingTransfer) {
        throw internalError("Failed to create MoonPay on-ramp transfer record");
      }
      precreatedTransferId = pendingTransfer.id;
      try {
        quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOnrampQuote(rampRuntime(c), {
          cryptoToken: input.cryptoToken,
          fiatCurrency: input.fiatCurrency,
          fiatAmount: input.fiatAmount,
          destinationWalletAddress,
          externalCustomerId: counterparty.id,
          paymentTransferId: pendingTransfer.id,
        });
        const updated = await getPaymentsRepository(c).updateTransfer({
          transferId: pendingTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          status: rampQuoteTransferStatus(quote),
          deliveryMode: quote.deliveryMode,
          updatedAt: new Date().toISOString(),
        });
        if (!updated) {
          throw internalError("Failed to complete MoonPay on-ramp transfer record");
        }
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
    case "lightspark": {
      const customerId = await lightsparkProviderCustomerId(c, counterparty, projectId);
      const purposeOfPayment = readLightsparkPurposeOfPayment(counterparty.provider_data);
      if (customerId === null || purposeOfPayment === null) {
        throw counterpartyNotProvisioned("lightspark", "onramp");
      }
      quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.id,
        customerId,
        purposeOfPayment,
        description: reservedTransferId,
      });
      break;
    }
    case "bvnk": {
      const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
      const bvnkResult = await bvnkOnrampQuote(c, {
        counterparty,
        paymentRule: {
          currency,
          network,
          fiatCurrency: input.fiatCurrency,
          destinationWalletAddress,
        },
      });
      quote = bvnkResult.quote;
      transferProviderData = bvnkResult.transferProviderData;
      break;
    }
    case "mural": {
      const account = await resolveMuralOnrampAccount(
        c,
        readMuralOrganization(counterparty.provider_data)
      );
      if (!account) {
        throw counterpartyNotProvisioned("mural", "onramp");
      }
      quote = muralOnrampQuote({ account, fiatCurrency: input.fiatCurrency });
      transferProviderData = { mural: { accountId: account.id } };
      break;
    }
    case "moneygram": {
      quote = await RAMP_PROVIDER_CLIENTS.moneygram.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.id,
      });
      break;
    }
    case "coinbase": {
      quote = await RAMP_PROVIDER_CLIENTS.coinbase.createOnrampQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.id,
        domain: input.domain,
      });
      break;
    }
    case "stripe": {
      quote = await stripeOnrampQuote(c, {
        counterparty,
        destinationWalletAddress,
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        customerIpAddress: getClientIp(c) ?? undefined,
      });
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

  const transferId = precreatedTransferId
    ? precreatedTransferId
    : await persistRampQuoteTransfer(c, {
        transferId: reservedTransferId,
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
        rampsMemo: input.rampsMemo,
        providerData: transferProviderData,
      });

  return success(c, { quote, transferId });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: provider dispatch keeps each off-ramp integration explicit, including its persistence and failure semantics.
export async function createOfframpQuote(c: AppContext): Promise<Response> {
  const {
    body: input,
    resolved: {
      scope,
      projectId,
      counterparty,
      wallet: sourceWallet,
      walletAddress: sourceWalletAddress,
    },
  } = getPolicyGateContext<CreateOfframpQuoteBody, RampQuotePolicyResolved>(c);

  await beginApprovedWalletOperationEffect(c);

  // Requirements/policy have succeeded. Reserve the ID now so the provider
  // quote and the eventual ledger row share the same internal transfer ID.
  const reservedTransferId = generatePaymentTransferId();
  let quote: PaymentRampQuote;
  let precreatedTransferId: string | undefined;
  let pendingTransfer: PaymentTransferRow | undefined;
  let transferProviderData: Record<string, unknown> | undefined;
  switch (input.provider) {
    case "moonpay": {
      const apiKey = c.get("apiKey");
      const pendingMoonpayTransfer = await getPaymentsRepository(c).createTransfer({
        id: reservedTransferId,
        organizationId: scope.auth.organizationId,
        projectId,
        custodyWalletId: sourceWallet.id,
        walletId: sourceWallet.walletId,
        counterpartyId: counterparty.id,
        sourceAddress: sourceWalletAddress,
        destinationAddress: null,
        token: rampTransferTokenMint(input.cryptoToken, c.env),
        amount: input.cryptoAmount,
        memo: null,
        type: "offramp",
        direction: "outbound",
        status: "pending",
        provider: "moonpay",
        providerReference: null,
        deliveryMode: null,
        fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
        fiatAmount: null,
        rampsMemo: input.rampsMemo,
        providerData: {},
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: apiKey ? apiKey.id : null,
      });
      if (!pendingMoonpayTransfer) {
        throw internalError("Failed to create MoonPay off-ramp transfer record");
      }
      precreatedTransferId = pendingMoonpayTransfer.id;
      try {
        quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOfframpQuote(rampRuntime(c), {
          cryptoToken: input.cryptoToken,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          externalCustomerId: counterparty.id,
          paymentTransferId: pendingMoonpayTransfer.id,
        });
        const updated = await getPaymentsRepository(c).updateTransfer({
          transferId: pendingMoonpayTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          status: rampQuoteTransferStatus(quote),
          deliveryMode: quote.deliveryMode,
          updatedAt: new Date().toISOString(),
        });
        if (!updated) {
          throw internalError("Failed to complete MoonPay off-ramp transfer record");
        }
      } catch (error) {
        await getPaymentsRepository(c).updateTransfer({
          transferId: pendingMoonpayTransfer.id,
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
    case "lightspark": {
      if (!input.fiatCurrency) {
        throw badRequest("fiatCurrency is required for Lightspark off-ramp.");
      }
      const customerId = await lightsparkProviderCustomerId(c, counterparty, projectId);
      const purposeOfPayment = readLightsparkPurposeOfPayment(counterparty.provider_data);
      const accountsRepository = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
      let payoutAccount: CounterpartyProviderAccountRow | null;
      if (input.providerAccountId === undefined) {
        const payoutAccounts = await accountsRepository.listActiveExternalAccounts({
          organizationId: scope.auth.organizationId,
          projectId,
          counterpartyId: counterparty.id,
          provider: "lightspark",
          fiatCurrency: input.fiatCurrency,
          destinationCountry: input.destinationCountry,
        });
        payoutAccount = selectLightsparkPayoutAccount(
          payoutAccounts,
          undefined,
          input.fiatCurrency,
          input.destinationCountry
        );
      } else {
        const selected = await accountsRepository.getExternalAccountById({
          organizationId: scope.auth.organizationId,
          projectId,
          counterpartyId: counterparty.id,
          provider: "lightspark",
          id: input.providerAccountId,
        });
        if (
          selected === null ||
          selected.status !== "active" ||
          selected.fiat_currency !== input.fiatCurrency ||
          selected.destination_country !== input.destinationCountry ||
          selected.external_account_reference === null ||
          selected.provider_status === null ||
          !isLightsparkExternalAccountActive(selected.provider_status)
        ) {
          throw badRequest(
            "providerAccountId does not reference an active lightspark payout account for this corridor."
          );
        }
        payoutAccount = selected;
      }
      if (
        customerId === null ||
        purposeOfPayment === null ||
        payoutAccount === null ||
        payoutAccount.external_account_reference === null ||
        payoutAccount.provider_status === null ||
        !isLightsparkExternalAccountActive(payoutAccount.provider_status)
      ) {
        throw counterpartyNotProvisioned("lightspark", "offramp");
      }
      transferProviderData = { payoutProviderAccountId: payoutAccount.id };
      quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOfframpQuote(rampRuntime(c), {
        cryptoToken: input.cryptoToken,
        fiatCurrency: input.fiatCurrency,
        cryptoAmount: input.cryptoAmount,
        sourceWalletAddress,
        externalCustomerId: counterparty.id,
        customerId,
        purposeOfPayment,
        payoutAccountId: payoutAccount.external_account_reference,
        description: reservedTransferId,
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
        transferId: reservedTransferId,
        organizationId: scope.auth.organizationId,
        projectId,
        counterpartyId: counterparty.id,
        custodyWalletId: sourceWallet.id,
        walletId: sourceWallet.walletId,
        walletAddress: sourceWalletAddress,
        cryptoToken: input.cryptoToken,
        cryptoAmount: input.cryptoAmount,
        fiatCurrency: input.fiatCurrency,
        rampsMemo: input.rampsMemo,
      });
      try {
        quote = await RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote(rampRuntime(c), {
          cryptoToken: input.cryptoToken,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          paymentTransferId: pendingTransfer.id,
          externalCustomerId: counterparty.id,
          bvnkCompliance: buildBvnkPartyDetails(counterparty),
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
        externalCustomerId: counterparty.id,
      });
      break;
    }
    case "mural":
      throw internalError("Mural off-ramp quote is not implemented yet.");
    case "coinbase":
      throw badRequest("Coinbase Onramp does not support off-ramp.");
    case "stripe":
      throw badRequest("Stripe off-ramp is not supported.");
    default: {
      const exhaustive: never = input;
      throw internalError(
        `Off-ramp quote provider is not implemented: ${JSON.stringify(exhaustive)}`
      );
    }
  }

  let transferId: string;
  if (pendingTransfer) {
    await completePendingBvnkOfframpTransfer(c, {
      organizationId: scope.auth.organizationId,
      projectId,
      transferId: pendingTransfer.id,
      quote,
      status: rampQuoteTransferStatus(quote),
    });
    transferId = pendingTransfer.id;
  } else if (precreatedTransferId) {
    transferId = precreatedTransferId;
  } else {
    transferId = await persistRampQuoteTransfer(c, {
      transferId: reservedTransferId,
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
      rampsMemo: input.rampsMemo,
      providerData: transferProviderData,
    });
  }

  return success(c, { quote, transferId });
}

export async function cancelRampTransfer(c: ValidatedBodyContext<typeof cancelRampTransferSchema>) {
  const input = c.req.valid("json");
  const scope = await resolveScope(c);
  const projectId = requireProjectId(c);
  const repository = getPaymentsRepository(c);

  const transfer = await repository.getTransferById({
    transferId: input.transferId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Transfer");
  }
  if (!isRampTransferType(transfer.type)) {
    throw badRequest("Only ramp transfers can be canceled through this endpoint.");
  }
  const cancelableStatuses: readonly PaymentTransferStatus[] = ["pending", "awaiting_payment"];
  if (!cancelableStatuses.includes(transfer.status)) {
    throw badRequest(`Transfer can no longer be canceled (status: ${transfer.status}).`);
  }

  const updated = await repository.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: scope.auth.organizationId,
    projectId,
    fromStatuses: cancelableStatuses,
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
    const providers = filterProviders(row.providers, resolveSdpEnvironment(c), provider);
    if (providers.length === 0) return [];
    return [{ source: row.source, dest: row.dest, providers }];
  });

  return success(c, {
    currencies: {
      sources: uniqueSorted(pairs.map((row) => row.source)),
      destinations: uniqueSorted(pairs.map((row) => row.dest)),
    },
    pairs,
    providerDetails: buildProviderDetails(providersFromPairs(pairs), "onramp"),
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
    const providers = filterProviders(row.providers, resolveSdpEnvironment(c), provider);
    if (providers.length === 0) return [];
    return [{ source: row.source, dest: row.dest, providers }];
  });

  return success(c, {
    currencies: {
      sources: uniqueSorted(pairs.map((row) => row.source)),
      destinations: uniqueSorted(pairs.map((row) => row.dest)),
    },
    pairs,
    providerDetails: buildProviderDetails(providersFromPairs(pairs), "offramp"),
    supportHash: RAMP_SUPPORT_HASH,
  });
}

export async function simulateSandboxTransfer(
  c: ValidatedBodyContext<typeof simulateSandboxTransferSchema>
) {
  if (resolveSdpEnvironment(c) !== "sandbox") {
    throw new AppError(
      "FORBIDDEN",
      "Sandbox transfer simulation is only available in sandbox mode"
    );
  }

  const body = c.req.valid("json");

  let transaction: unknown;
  switch (body.provider) {
    case "lightspark":
      transaction = await RAMP_PROVIDER_CLIENTS.lightspark.sandboxSend(
        rampRuntime(c),
        body.payload
      );
      break;
    case "bvnk": {
      const payload = body.payload;
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
    case "mural": {
      const payload = body.payload;
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
      const org = readMuralOrganization(counterparty.provider_data);
      if (!org.id) {
        throw badRequest("Mural organization is not provisioned yet for this counterparty.");
      }
      const account = await resolveMuralOnrampAccount(c, org);
      if (!account) {
        throw badRequest("Mural account is not active yet for this counterparty.");
      }
      const rail = {
        USD: "wire",
        MXN: "spei",
        BRL: "pix",
        ARS: "cvu",
      } as const satisfies Record<typeof payload.fiatCurrency, "wire" | "spei" | "pix" | "cvu">;
      transaction = await RAMP_PROVIDER_CLIENTS.mural.simulatePayin(rampRuntime(c), {
        organizationId: org.id,
        destinationAccountId: account.id,
        rail: rail[payload.fiatCurrency],
        amountValue: String(parseDecimalAmount(String(payload.amount), 2)),
        currencySymbol: payload.fiatCurrency,
      });
      break;
    }
  }

  return success(c, { transaction });
}
