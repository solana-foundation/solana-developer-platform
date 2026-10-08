import { SdpPaymentsError } from "@sdp/payments";
import { readyCounterparty } from "@sdp/payments/ramps/requirements";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { redactCredentialString } from "@sdp/redaction";
import {
  isStagedProviderRefusalReason,
  type PaymentRampEstimate,
  type PaymentRampQuote,
  type RampProviderEstimateResult,
} from "@sdp/types";
import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  RAMP_PROVIDER_SUPPORT_DETAILS,
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
import type { z } from "zod";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  conflict,
  internalError,
  redactErrorForCapture,
  unsupportedRampCorridor,
} from "@/lib/errors";
import { assertRampProviderInChannel, isRampProviderInChannel } from "@/middleware/require-module";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import type { SubmitCounterpartyRequirementsInput } from "@/routes/counterparties/schemas";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import {
  assertProviderAvailable,
  assertRampProviderSurfaced,
  loadProjectProviderVerdict,
} from "@/services/provider-availability.service";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../context";
import {
  assertFreshPaymentWalletAccess,
  assertPaymentWalletExactAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";
import type { createOfframpQuoteSchema } from "./offramp/schemas";
import type { createOnrampQuoteSchema } from "./onramp/schemas";
import { advanceBvnkRequirements } from "./providers/bvnk";
import { advanceLightsparkRequirements } from "./providers/lightspark";
import { resolveMuralRequirements } from "./providers/mural";
import {
  assertRampQuoteBindingMatches,
  isRampQuoteBindingExpired,
  type RampQuoteBinding,
  rampQuoteCryptoDepositProviderData,
  rampQuoteExpiryProviderData,
} from "./quote-binding";

type ScopedSubmitCounterpartyRequirementsInput = SubmitCounterpartyRequirementsInput & {
  counterparty: CounterpartyRow;
  projectId: string;
};

/**
 * Whether SDP offers ramp `provider` on this request: the release channel
 * includes it and it is surfaced for the request's environment.
 */
function isRampProviderOffered(c: AppContext, provider: RampProviderId): boolean {
  return (
    isRampProviderInChannel(c, provider) &&
    isRampProviderSurfaced(provider, resolveSdpEnvironment(c))
  );
}

/**
 * Refuses a request that names a ramp provider SDP does not offer: outside the
 * release channel, or not surfaced for the request's environment.
 */
export function assertRampProviderOffered(c: AppContext, provider: RampProviderId): void {
  assertRampProviderInChannel(c, provider);
  assertRampProviderSurfaced(provider, resolveSdpEnvironment(c));
}

/**
 * The offered providers among `providers`, narrowed to `provider` when the
 * request names one. A request naming a provider outside the release channel is
 * refused before this (`assertRampProviderInChannel`), not answered with nothing.
 */
export function filterProviders(
  c: AppContext,
  providers: readonly RampProviderId[],
  provider?: RampProviderId
): RampProviderId[] {
  const offered = providers.filter((p) => isRampProviderOffered(c, p));
  if (provider) {
    return offered.includes(provider) ? [provider] : [];
  }
  return offered;
}

export function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

export function buildProviderDetails(
  providerIds: readonly RampProviderId[],
  direction: "onramp" | "offramp"
): Partial<Record<RampProviderId, RampProviderDirectionSupport>> {
  const providerDetails: Partial<Record<RampProviderId, RampProviderDirectionSupport>> = {};
  for (const providerId of providerIds) {
    providerDetails[providerId] = RAMP_PROVIDER_SUPPORT_DETAILS[providerId][direction];
  }
  return providerDetails;
}

export function providersFromPairs(
  pairs: readonly { providers: readonly RampProviderId[] }[]
): RampProviderId[] {
  return uniqueSorted(pairs.flatMap((row) => row.providers));
}

type RampQuoteDirection = "onramp" | "offramp";

/**
 * Throws unless the committed corridor-support matrix (the same tables estimate
 * selects providers from) lists the provider for the requested crypto/fiat pair.
 * When fiatCurrency is omitted (off-ramp quotes may defer fiat selection to the
 * provider), the provider must support the crypto rail for at least one fiat.
 */
function assertRampCorridorSupported(
  c: AppContext,
  direction: RampQuoteDirection,
  input: { provider: RampProviderId; assetRail: CryptoRailId; fiatCurrency?: RampFiatCurrency }
): void {
  const { assetRail } = input;
  const pairs: readonly (OnrampPairSupport | OfframpPairSupport)[] =
    direction === "onramp" ? ONRAMP_SUPPORT : OFFRAMP_SUPPORT;
  const fiat = input.fiatCurrency;
  const matched = pairs.filter((pair) => {
    const railSide = direction === "onramp" ? pair.dest : pair.source;
    const fiatSide = direction === "onramp" ? pair.source : pair.dest;
    return railSide === assetRail && (fiat === undefined || fiatSide === fiat);
  });
  const supportedProviders = providersFromPairs(matched).filter((p) => isRampProviderOffered(c, p));
  if (!supportedProviders.includes(input.provider)) {
    throw unsupportedRampCorridor(input.provider, direction, {
      assetRail,
      fiatCurrency: fiat,
      supportedProviders,
    });
  }
}
type ScopedRampWallet = ResolvedScope["wallets"][number];

export type CreateOnrampQuoteBody = z.output<typeof createOnrampQuoteSchema>;

export type CreateOfframpQuoteBody = z.output<typeof createOfframpQuoteSchema>;

export interface RampQuotePolicyResolved {
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
  assetRail: CryptoRailId;
  cryptoAmount: string | null;
  fiatCurrency: RampFiatCurrency | null;
  fiatAmount: string | null;
  rampsMemo: Record<string, string> | undefined;
  providerData?: Record<string, unknown>;
}

/**
 * Resolve the state shared by both ramp-quote extractions: corridor support,
 * provider availability, the counterparty, and the SDP wallet on the crypto
 * leg. The wallet is keyed by its internal custody wallet id.
 *
 * @param c - Request context.
 * @param direction - The quote direction.
 * @param input - The validated quote request body.
 * @param custodyWalletId - The internal custody wallet id from the request.
 * @returns The resolved scope, project, counterparty, wallet, and address.
 */
export async function resolveRampQuoteRequest(
  c: AppContext,
  direction: RampQuoteDirection,
  input: CreateOnrampQuoteBody | CreateOfframpQuoteBody,
  custodyWalletId: string
): Promise<RampQuotePolicyResolved> {
  assertRampProviderOffered(c, input.provider);
  assertRampCorridorSupported(c, direction, input);
  const scope = await resolveScope(c);
  await assertProviderAvailable(c, { family: "ramps", provider: input.provider });

  const projectId = requireProjectId(c);
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }

  const wallet = resolveWalletByCustodyWalletId(scope.wallets, custodyWalletId);
  assertPaymentWalletExactAccess(c, wallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, wallet, ["payments:write"]);
  return { scope, projectId, counterparty, wallet, walletAddress: wallet.publicKey };
}

export function rampQuoteTransferStatus(quote: PaymentRampQuote): PaymentTransferStatus {
  if (quote.deliveryMode === "manual_instructions" && quote.status === "pending") {
    return "awaiting_payment";
  }
  return quote.status;
}

export async function persistRampQuoteTransfer(
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
    token: rampTransferTokenMint(input.assetRail, c.env),
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
        ...rampQuoteCryptoDepositProviderData(input.quote, input.cryptoAmount),
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
    case "bvnk":
      return advanceBvnkRequirements(c, input);
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
  const verdict = await loadProjectProviderVerdict(c);

  const settled = await mapSettledWithConcurrency(
    [...providers],
    RAMP_ESTIMATE_PROVIDER_CONCURRENCY,
    async (provider): Promise<RampProviderEstimateResult> => {
      try {
        const decision = verdict({ family: "ramps", provider });
        if (!decision.admitted) {
          if (!isStagedProviderRefusalReason(decision.reason)) {
            throw decision.error;
          }
          logEvent("info", {
            event: "sdp_api_ramp_provider_refused",
            provider,
            organization_id: scope.auth.organizationId,
            reason: decision.reason,
          });
          return {
            provider,
            status: "error",
            error: decision.error.message,
            reason: decision.reason,
          };
        }
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
        if (observability) {
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
